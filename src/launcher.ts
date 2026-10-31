import * as coc from "coc.nvim";
import * as cp from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { AttachTarget, DebugBackend, detectBackend } from "./debug";
import { AppLauncher, AppState, LaunchOptions, LaunchTarget, jmxArgs } from "./launch";
import { OutputTabs } from "./output";
import { LaunchArguments, LaunchPanel, LaunchSettings, defaultSettings, launchArguments } from "./settings";
import { waitFor } from "./ready";
import { command, config, failed, javaCommand, sleep } from "./util";

/**
 * An app the dashboard started: its terminal, the JVM and what a debugger needs to attach.
 */
interface Session {
    state: AppState;
    terminal?: coc.Terminal;
    pid?: number;
    jdwpPort?: number;
    backend?: DebugBackend;
    attached?: AttachTarget;
    killer?: NodeJS.Timeout;
}

/**
 * Starts the apps as a JVM in a terminal, owned by the dashboard: it knows the pid, shows the output and stops the app.
 * A debugger only attaches to the JDWP port of the JVM.
 */
export class TerminalLauncher implements AppLauncher {
    private readonly sessions: Map<string, Session> = new Map();
    private readonly emitter = new coc.Emitter<void>();
    public readonly onDidChangeState: coc.Event<void> = this.emitter.event;

    /** Whether the live data has a process of a pid, set from the live data: its own connection ends the polling. */
    public connected: (pid: number) => boolean = () => false;

    private readonly panel: LaunchPanel;

    constructor(private readonly context: coc.ExtensionContext, private readonly output: OutputTabs) {
        this.panel = new LaunchPanel(context);
        context.subscriptions.push(coc.window.onDidCloseTerminal(t => this.closed(t)), this.emitter);
    }

    public async run(app: LaunchTarget, options?: LaunchOptions): Promise<string> {
        return this.start(app, options ?? {}, false);
    }

    public async debug(app: LaunchTarget, options?: LaunchOptions): Promise<string> {
        return this.start(app, options ?? {}, true);
    }

    public async configure(app: LaunchTarget): Promise<string> {
        const settings: LaunchSettings | undefined = await this.panel.open(app, "Save");
        let message: string;
        if (settings === undefined) {
            message = `${app.name} settings unchanged`;
        } else {
            message = `${app.name} settings saved`;
            coc.window.showInformationMessage(message);
        }
        return message;
    }

    // the tab, or the terminal of the last run when the tab was closed
    public async hasOutput(app: LaunchTarget): Promise<boolean> {
        return (await this.output.has(app.mainClass)) || await this.terminalOf(app) !== undefined;
    }

    private async terminalOf(app: LaunchTarget): Promise<number | undefined> {
        const bufnr: number | undefined = this.sessions.get(app.mainClass)?.terminal?.bufnr;
        const loaded: boolean = bufnr !== undefined && (await coc.workspace.nvim.call("bufloaded", [bufnr])) as number === 1;
        return loaded ? bufnr : undefined;
    }

    /**
     * Switches to the tab of the app, the tab is built again from the terminal of the last run when it was closed.
     */
    public async showOutput(app: LaunchTarget): Promise<string> {
        let shown: boolean = await this.output.focus(app.mainClass);
        const bufnr: number | undefined = shown ? undefined : await this.terminalOf(app);
        if (bufnr !== undefined) {
            await this.output.show({ key: app.mainClass, name: app.name, folder: app.path }, bufnr, { focus: true });
            shown = true;
        }
        let message: string;
        if (shown) {
            message = `Dashboard ${app.name}`;
        } else {
            message = `${app.name} not run yet`;
            coc.window.showWarningMessage(message);
        }
        return message;
    }

    public async attach(app: LaunchTarget): Promise<string> {
        const session: Session | undefined = this.sessions.get(app.mainClass);
        let message: string;
        if (session === undefined || session.state !== "running" || session.jdwpPort === undefined) {
            message = `${app.name} not started with Run`;
            coc.window.showWarningMessage(message);
        } else {
            const backend: DebugBackend | undefined = await detectBackend();
            if (backend === undefined) {
                message = this.noDebugger();
            } else {
                message = await this.attachTo(app, session, backend, session.jdwpPort);
            }
        }
        return message;
    }

    public async stop(app: LaunchTarget, pid?: number): Promise<string> {
        const session: Session | undefined = this.sessions.get(app.mainClass);
        const target: number | undefined = session && session.state !== "stopped" ? session.pid : pid;
        let message: string;
        if (target === undefined) {
            message = `${app.name} not running`;
            coc.window.showWarningMessage(message);
        } else {
            this.terminate(target, session, app.name);
            message = `Stopping ${app.name}`;
        }
        return message;
    }

    public state(app: LaunchTarget): AppState {
        return this.sessions.get(app.mainClass)?.state ?? "stopped";
    }

    public pidOf(app: LaunchTarget): number | undefined {
        const session: Session | undefined = this.sessions.get(app.mainClass);
        return session && session.state !== "stopped" ? session.pid : undefined;
    }

    private async start(app: LaunchTarget, options: LaunchOptions, debug: boolean): Promise<string> {
        const existing: Session | undefined = this.sessions.get(app.mainClass);
        let message: string;
        if (existing && existing.state !== "stopped") {
            message = `${app.name} already running`;
            coc.window.showWarningMessage(message);
        } else {
            message = await this.startNew(app, options, debug);
        }
        return message;
    }

    private async startNew(app: LaunchTarget, options: LaunchOptions, debug: boolean): Promise<string> {
        const backend: DebugBackend | undefined = debug ? await detectBackend() : undefined;
        let message: string;
        if (debug && backend === undefined) {
            message = this.noDebugger();
        } else {
            const values: LaunchSettings | undefined = await this.settings(app, debug ? "Debug" : "Run", options);
            if (values === undefined) {
                message = `${app.name} cancelled`;
            } else {
                const session: Session = { state: "starting", backend };
                this.sessions.set(app.mainClass, session);
                this.emitter.fire();
                message = await this.launch(app, session, values, debug).catch(e => {
                    this.setState(session, "stopped");
                    failed(`start ${app.name}`, e, undefined);
                    coc.window.showErrorMessage(`${app.name} did not start`);
                    return `${app.name} did not start`;
                });
            }
        }
        return message;
    }

    /**
     * Resolves the java executable and the classpath through jdtls, starts the JVM in a terminal and, for debug, attaches.
     */
    private async launch(app: LaunchTarget, session: Session, settings: LaunchSettings, debug: boolean): Promise<string> {
        const java: string = await javaCommand<string>("vscode.java.resolveJavaExecutable", app.mainClass, app.projectName);
        const [modulePaths, classPaths]: string[][] = await javaCommand<string[][]>("vscode.java.resolveClasspath", app.mainClass, app.projectName);
        const jdwpPort: number = await freePort();
        const jmxPort: number = await freePort();

        const launch: LaunchArguments = launchArguments(settings);
        const argfile: string = this.writeArgfile(app, modulePaths ?? [], classPaths ?? [], launch.args);
        const vmArgs: string[] = [
            ...launch.vmArgs,
            ...jmxArgs(app.projectName, jmxPort),
            `-agentlib:jdwp=transport=dt_socket,server=y,suspend=${debug ? "y" : "n"},address=127.0.0.1:${jdwpPort}`,
            `@${argfile}`,
        ];
        const origin: number = await this.output.origin();
        const terminal: coc.Terminal = await coc.window.createTerminal({ name: `Spring: ${app.name}`, shellPath: java, shellArgs: vmArgs, cwd: app.path, env: launch.env });
        session.terminal = terminal;
        session.jdwpPort = jdwpPort;
        session.pid = await terminal.processId;
        void connectLive(session, () => session.pid !== undefined && this.connected(session.pid));
        await this.output.show({ key: app.mainClass, name: app.name, folder: app.path }, terminal.bufnr, { focus: config<boolean>("launch.focusOutput", false), origin });

        let message: string;
        if (debug && session.backend) {
            this.setState(session, "waiting");
            message = await this.attachTo(app, session, session.backend, jdwpPort);
        } else {
            this.setState(session, "running");
            message = `Started ${app.name}`;
        }
        return message;
    }

    /**
     * Starts the java-debug adapter and attaches the backend, the JVM is killed when no debugger attaches in time.
     */
    private async attachTo(app: LaunchTarget, session: Session, backend: DebugBackend, jdwpPort: number): Promise<string> {
        const wasWaiting: boolean = session.state === "waiting";
        let message: string;
        try {
            const adapterPort: number = await javaCommand<number>("vscode.java.startDebugSession");
            const target: AttachTarget = { name: app.name, projectName: app.projectName, adapterPort, jdwpPort };
            await backend.attach(target, config<number>("debug.attachTimeout", 30) * 1000);
            session.attached = target;
            this.setState(session, "debugging");
            this.watchDebugger(session, backend, target);
            message = `Debugging ${app.name}`;
        } catch (e) {
            if (wasWaiting && session.pid !== undefined) {
                this.terminate(session.pid, session, app.name);
            }
            failed(`attach ${app.name}`, e, undefined);
            message = wasWaiting ? `${app.name} stopped, no debugger` : "Debugger not attached";
            coc.window.showErrorMessage(message);
        }
        return message;
    }

    /**
     * Ending the debug session only detaches, the app goes back to running.
     */
    private watchDebugger(session: Session, backend: DebugBackend, target: AttachTarget): void {
        const timer: NodeJS.Timeout = setInterval(() => {
            if (session.state !== "debugging") {
                clearInterval(timer);
            } else {
                backend.attached(target).then(attached => {
                    if (!attached && session.state === "debugging") {
                        clearInterval(timer);
                        this.setState(session, "running");
                    }
                }).catch(() => undefined);
            }
        }, 2000);
    }

    /**
     * SIGTERM lets spring shut down cleanly, SIGKILL follows when the process is still there after the grace period.
     */
    private terminate(pid: number, session: Session | undefined, name: string): void {
        signal(pid, false).then(async ok => {
            if (!ok && await alive(pid)) {
                coc.window.showErrorMessage(`${name} not stopped`);
            }
        }).catch(() => undefined);
        if (session?.killer) {
            clearTimeout(session.killer);
        }
        const killer: NodeJS.Timeout = setTimeout(() => {
            alive(pid).then(running => running ? signal(pid, true) : undefined).catch(() => undefined);
        }, config<number>("stop.gracePeriod", 10) * 1000);
        killer.unref();
        if (session) {
            session.killer = killer;
        }
    }

    private closed(terminal: coc.Terminal): void {
        for (const session of this.sessions.values()) {
            if (session.terminal === terminal) {
                this.setState(session, "stopped");
            }
        }
    }

    private setState(session: Session, state: AppState): void {
        session.state = state;
        this.emitter.fire();
    }

    /**
     * The settings of a launch: the panel the first time per app, every time or never, as `spring.dashboard.launch.prompt`
     * says, otherwise the remembered ones. A profile of the command replaces the profiles, the "with profile" commands
     * open the panel with the profiles first. Undefined when cancelled.
     */
    private async settings(app: LaunchTarget, action: string, options: LaunchOptions): Promise<LaunchSettings | undefined> {
        const mode: string = config<string>("launch.prompt", "first");
        const saved: LaunchSettings | undefined = this.panel.saved(app);
        const initial: LaunchSettings = { ...(saved ?? defaultSettings(app)) };
        if (options.profile !== undefined) {
            initial.profiles = options.profile.split(",").map(p => p.trim()).filter(p => p.length > 0);
        }
        let settings: LaunchSettings | undefined;
        if (options.pickProfiles || mode === "always" || (mode !== "never" && saved === undefined)) {
            settings = await this.panel.open(app, action, options.pickProfiles ? "profiles" : undefined, initial);
        } else {
            settings = initial;
        }
        return settings;
    }

    /**
     * The argfile of the JVM: module path, class path, main class and program arguments, a classpath can be too long
     * for the command line.
     */
    private writeArgfile(app: LaunchTarget, modulePaths: string[], classPaths: string[], args: string[]): string {
        const lines: string[] = [];
        if (modulePaths.length > 0) {
            lines.push("-p", quote(modulePaths.join(path.delimiter)));
        }
        lines.push("-cp", quote(classPaths.join(path.delimiter)), app.mainClass, ...args.map(quote));
        fs.mkdirSync(this.context.storagePath, { recursive: true });
        const file: string = path.join(this.context.storagePath, `${app.mainClass}.args`);
        fs.writeFileSync(file, lines.join("\n") + "\n");
        return file;
    }

    private noDebugger(): string {
        const message: string = "No debugger found";
        coc.window.showWarningMessage(message);
        return message;
    }
}

const WINDOWS: boolean = process.platform === "win32";
const LIVE_CONNECT = "sts/livedata/connect";
const LIVE_POLL_MS = [2000, 4000, 8000, 15000];
const LIVE_GIVE_UP_MS = 180000;
const LIST_TIMEOUT_MS = 10000;

function quote(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/**
 * A free port from the OS, right before it is used.
 */
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server: net.Server = net.createServer();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const port: number = (server.address() as net.AddressInfo).port;
            server.close(() => resolve(port));
        });
    });
}

/**
 * Runs a command and tells whether it exited with 0. coc's extension sandbox rejects process.kill, so the signals go
 * through a child process.
 */
function exec(command: string, args: string[]): Promise<{ ok: boolean, out: string }> {
    return new Promise(resolve => {
        cp.execFile(command, args, { windowsHide: true }, (error, stdout) => resolve({ ok: error === null, out: String(stdout) }));
    });
}

/**
 * `kill -TERM` or `taskkill /PID`, force is `kill -KILL` or `taskkill /F /PID`.
 */
async function signal(pid: number, force: boolean): Promise<boolean> {
    let ok: boolean;
    if (WINDOWS) {
        ok = (await exec("taskkill", [...(force ? ["/F"] : []), "/PID", String(pid)])).ok;
    } else {
        ok = (await exec("kill", [force ? "-KILL" : "-TERM", String(pid)])).ok;
    }
    return ok;
}

async function alive(pid: number): Promise<boolean> {
    let result: boolean;
    if (WINDOWS) {
        result = (await exec("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"])).out.includes(`"${pid}"`);
    } else {
        result = (await exec("kill", ["-0", String(pid)])).ok;
    }
    return result;
}

/**
 * Connects the live data of a started app: once the spring boot server is ready the entry of the session's pid in its
 * list of local processes is connected as soon as it shows up, its automatic connection does not reliably pick up a
 * fresh JVM. The list is asked for with a growing delay (2, 4, 8, then every 15 s), one request at a time, until the app
 * is connected, by the server itself too, or the app stops. After 3 minutes of asking it gives up with a line in the
 * output channel; an entry already connected offers refresh instead.
 */
async function connectLive(session: Session, connected: () => boolean): Promise<void> {
    const pid: string = String(session.pid);
    // the list keys a local process by its pid alone, `<pid> - <main class>` once connected, the label ends in `(pid: N)`
    const ours = (p: any): boolean =>
        p?.processKey === pid || (typeof p?.processKey === "string" && p.processKey.startsWith(`${pid} - `)) || (typeof p?.label === "string" && p.label.endsWith(`(pid: ${pid})`));
    const stopped = (): boolean => session.state === "stopped" || connected();
    if (await waitFor("spring", stopped)) {
        const until: number = Date.now() + LIVE_GIVE_UP_MS;
        let attempt: number = 0;
        while (!stopped() && Date.now() < until) {
            await sleep(LIVE_POLL_MS[Math.min(attempt++, LIVE_POLL_MS.length - 1)]);
            if (!stopped()) {
                const processes: any[] = (await Promise.race([command<any[]>("sts/livedata/listProcesses"), new Promise<any[]>(resolve => setTimeout(() => resolve([]), LIST_TIMEOUT_MS))]).catch(() => [])) ?? [];
                const entry: any = processes.find(ours);
                if (entry !== undefined && !stopped() && entry.action === LIVE_CONNECT) {
                    await command(LIVE_CONNECT, entry).catch(() => undefined);
                }
            }
        }
        if (!stopped()) {
            failed(`connect the live data of ${pid}`, "not connected after 3 minutes", undefined);
        }
    }
}
