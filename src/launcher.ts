import * as coc from "coc.nvim";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { AttachTarget, DebugBackend, detectBackend } from "./debug";
import { AppLauncher, AppState, AttachOptions, AttachProject, LaunchOptions, LaunchTarget, jmxArgs } from "./launch";
import { OutputTabs, TabApp, sourceWindowOf } from "./output";
import { AttachPanel, RemoteTarget, attachSettings, rememberAttach, withOptions } from "./attach-settings";
import { LaunchArguments, LaunchPanel, LaunchSettings, isRemembered, launchArguments, launchSettings, withLaunchDefaults } from "./launch-settings";
import { connectJmx, connectPid, disconnectPid } from "./remote";
import { need, waitFor } from "./ready";
import { config, failed, javaCommand } from "./util";

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

    private readonly panel: LaunchPanel;
    private readonly attachPanel: AttachPanel;

    constructor(private readonly context: coc.ExtensionContext, private readonly output: OutputTabs) {
        this.panel = new LaunchPanel(context.workspaceState);
        this.attachPanel = new AttachPanel(context.workspaceState);
        context.subscriptions.push(coc.window.onDidCloseTerminal(t => this.closed(t)), this.emitter);
    }

    public async run(app: LaunchTarget, options?: LaunchOptions): Promise<string> {
        return this.start(app, options ?? {}, false);
    }

    public async debug(app: LaunchTarget, options?: LaunchOptions): Promise<string> {
        return this.start(app, options ?? {}, true);
    }

    public async configure(app: LaunchTarget): Promise<string> {
        const settings: LaunchSettings | undefined = await this.panel.open(app, "Save", launchSettings(this.context.workspaceState, app));
        let message: string;
        if (settings === undefined) {
            message = `${app.name} settings unchanged`;
        } else {
            message = `${app.name} settings saved`;
            void coc.window.showInformationMessage(message);
        }
        return message;
    }

    // the tab, or the terminal of the running app when the tab was closed
    public async hasOutput(app: LaunchTarget): Promise<boolean> {
        return (await this.output.has(app.mainClass)) || await this.terminalOf(app) !== undefined;
    }

    private async terminalOf(app: LaunchTarget): Promise<number | undefined> {
        const bufnr: number | undefined = this.sessions.get(app.mainClass)?.terminal?.bufnr;
        const loaded: boolean = bufnr !== undefined && (await coc.workspace.nvim.call("bufloaded", [bufnr])) as number === 1;
        return loaded ? bufnr : undefined;
    }

    /**
     * Switches to the tab of the app, the tab is built again from the terminal of the running app when it was closed.
     */
    public async showOutput(app: LaunchTarget): Promise<string> {
        let shown: boolean = await this.output.focus(app.mainClass);
        const bufnr: number | undefined = shown ? undefined : await this.terminalOf(app);
        if (bufnr !== undefined) {
            await this.output.show({ key: app.mainClass, name: app.name, folder: app.path }, bufnr);
            shown = true;
        }
        let message: string;
        if (shown) {
            message = `Dashboard ${app.name}`;
        } else {
            message = `${app.name} not running`;
            void coc.window.showWarningMessage(message);
        }
        return message;
    }

    public async attach(app: LaunchTarget): Promise<string> {
        const session: Session | undefined = this.sessions.get(app.mainClass);
        let message: string;
        if (session?.state !== "running" || session.jdwpPort === undefined) {
            message = `${app.name} not started with Run`;
            void coc.window.showWarningMessage(message);
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

    /**
     * Attaches to an app the dashboard did not start: the live data over JMX and the debugger over JDWP, each when its port
     * is set, one failing does not undo the other. The dashboard tab of the app opens with the four views. Any option
     * skips the panel, the missing ones come from the settings of the project (the only one when none is given). An attach
     * remembers its host and ports per project.
     */
    public async attachRemote(options: AttachOptions, projects: AttachProject[]): Promise<string> {
        const given: boolean = Object.values(options).some(v => v !== undefined);
        const names: string[] = [...new Set(projects.map(p => p.name))];
        const project: string = String(options.project ?? (names.length === 1 ? names[0] : "")).trim();
        const settings: RemoteTarget | undefined = given ? withOptions(attachSettings(this.context.workspaceState, project), options) : await this.attachPanel.open(names);
        let message: string;
        if (settings === undefined) {
            message = "Attach cancelled";
        } else if (settings.jmxPort === "" && settings.debugPort === "") {
            message = "No port to attach";
            void coc.window.showWarningMessage(message);
        } else if (settings.project === "") {
            message = "No project to attach";
            void coc.window.showWarningMessage(message);
        } else {
            await rememberAttach(this.context.workspaceState, settings);
            // the tab first: the debugger finds the source window of the attach through it
            const project: AttachProject | undefined = projects.find(p => p.name === settings.project);
            const tab: TabApp = { key: attachKey(settings.project), name: settings.project, folder: project?.path ?? coc.workspace.root };
            await this.output.showViews(tab, await this.output.origin());
            const messages: string[] = [];
            const debug = settings.debugPort !== "" ? await this.attachDebugger(settings) : undefined;
            if (debug !== undefined) {
                messages.push(debug.message);
            }
            if (settings.jmxPort !== "") {
                messages.push((await this.attachLive(settings)).message);
            }
            message = messages.join(", ");
        }
        return message;
    }

    private async attachLive(s: RemoteTarget): Promise<{ message: string; ok: boolean }> {
        let message: string = `${s.project}: live data connecting`;
        let ok: boolean = true;
        if (need("spring")) {
            await connectJmx(s.host, s.jmxPort, s.project).catch(e => {
                failed(`connect ${s.host}:${s.jmxPort}`, e, undefined);
                message = `${s.project}: live data not connected`;
                ok = false;
            });
        } else {
            message = "Spring Boot server not running";
            ok = false;
        }
        if (ok) {
            void coc.window.showInformationMessage(message);
        }
        return { message, ok };
    }

    private async attachDebugger(s: RemoteTarget): Promise<{ message: string; ok: boolean }> {
        const backend: DebugBackend | undefined = await detectBackend();
        let message: string = `${s.project}: debugger attached`;
        let ok: boolean = false;
        if (backend === undefined) {
            message = this.noDebugger();
        } else if (!need("java")) {
            message = "Java server starting";
        } else if (!await reachable(s.host, Number(s.debugPort))) {
            message = `Nothing on ${s.host}:${s.debugPort}`;
            void coc.window.showWarningMessage(message);
        } else {
            try {
                await this.attachBackend(backend, { name: s.project, tab: attachKey(s.project), projectName: s.project, host: s.host, jdwpPort: Number(s.debugPort) });
                ok = true;
                void coc.window.showInformationMessage(message);
            } catch (e) {
                failed(`attach ${s.project}`, e, undefined);
                message = "Debugger not attached";
                void coc.window.showErrorMessage(message);
            }
        }
        return { message, ok };
    }

    /**
     * Starts the java-debug adapter and attaches the backend to the JDWP port of the target, within the attach timeout.
     */
    private async attachBackend(backend: DebugBackend, target: Omit<AttachTarget, "adapterPort">): Promise<AttachTarget> {
        // the dashboard tab is there, the debugger starts from the source window: a debugger ui opens in the tab that is
        // current when the session starts (vimspector also reads the current buffer)
        const source: number | undefined = await sourceWindowOf(target.tab);
        if (source !== undefined) {
            await coc.workspace.nvim.call("win_gotoid", [source]);
        }
        const adapterPort: number = await javaCommand<number>("vscode.java.startDebugSession");
        const attached: AttachTarget = { ...target, adapterPort };
        await backend.attach(attached, config<number>("debug.attachTimeout", 30) * 1000);
        return attached;
    }

    public stop(app: LaunchTarget, pid?: number): Promise<string> {
        // the body runs right away and a throw rejects, like the body of an async function
        return new Promise<string>(resolve => {
            const session: Session | undefined = this.sessions.get(app.mainClass);
            const target: number | undefined = session && session.state !== "stopped" ? session.pid : pid;
            let message: string;
            if (target === undefined) {
                message = `${app.name} not running`;
                void coc.window.showWarningMessage(message);
            } else {
                this.terminate(target, session, app.name);
                message = `Stopping ${app.name}`;
            }
            resolve(message);
        });
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
            void coc.window.showWarningMessage(message);
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
                    void coc.window.showErrorMessage(`${app.name} did not start`);
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

        const launch: LaunchArguments = launchArguments(withLaunchDefaults(settings));
        const argfile: string = this.writeArgfile(app, modulePaths ?? [], classPaths ?? [], launch.programArgs);
        const vmArgs: string[] = [
            ...launch.vmArgs,
            ...jmxArgs(app.projectName, jmxPort),
            `-agentlib:jdwp=transport=dt_socket,server=y,suspend=${debug ? "y" : "n"},address=127.0.0.1:${jdwpPort}`,
            `@${argfile}`,
        ];
        const origin: number = await this.output.origin();
        const terminal: coc.Terminal = await coc.window.createTerminal({ name: `Spring: ${app.name}`, shellPath: java, shellArgs: vmArgs, cwd: app.path, env: launch.envVars });
        session.terminal = terminal;
        session.jdwpPort = jdwpPort;
        session.pid = await terminal.processId;
        void connectLive(session, app);
        await this.output.show({ key: app.mainClass, name: app.name, folder: app.path }, terminal.bufnr, origin);

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
            const target: AttachTarget = await this.attachBackend(backend, { name: app.name, tab: app.mainClass, projectName: app.projectName, host: "127.0.0.1", jdwpPort });
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
            void coc.window.showErrorMessage(message);
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
                void coc.window.showErrorMessage(`${name} not stopped`);
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

    // coc wipes the buffer of a terminal whose process exited
    private closed(terminal: coc.Terminal): void {
        for (const [key, session] of this.sessions) {
            if (session.terminal === terminal) {
                this.setState(session, "stopped");
                void this.output.stopped(key);
            }
        }
    }

    private setState(session: Session, state: AppState): void {
        session.state = state;
        if (state === "stopped" && session.pid !== undefined) {
            void disconnectPid(session.pid).catch(() => undefined);
        }
        this.emitter.fire();
    }

    /**
     * The settings of the app for a launch, before `launch.defaults`: through the panel every time (the default), the
     * first time per app or never, as `spring.dashboard.launch.prompt` says. A profile of the command replaces the
     * profiles of the app, the "with profile" commands open the panel with the profiles first. Undefined when cancelled.
     */
    private async settings(app: LaunchTarget, action: string, options: LaunchOptions): Promise<LaunchSettings | undefined> {
        const mode: string = config<string>("launch.prompt", "always");
        const own: LaunchSettings = launchSettings(this.context.workspaceState, app);
        const initial: LaunchSettings = options.profile === undefined ? own : { ...own, profiles: options.profile.split(",").map(p => p.trim()).filter(p => p.length > 0) };
        let settings: LaunchSettings | undefined;
        if (options.pickProfiles || mode === "always" || (mode !== "never" && !isRemembered(this.context.workspaceState, app))) {
            settings = await this.panel.open(app, action, initial, options.pickProfiles ? "profiles" : undefined);
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
        void coc.window.showWarningMessage(message);
        return message;
    }
}

const WINDOWS: boolean = process.platform === "win32";

function quote(value: string): string {
    const backslash: string = String.raw`\\`;
    const doubleQuote: string = String.raw`\"`;
    return `"${value.replace(/\\/g, backslash).replace(/"/g, doubleQuote)}"`;
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
 * Whether something listens on a port, a connection is tried for 3 seconds.
 */
function reachable(host: string, port: number): Promise<boolean> {
    return new Promise(resolve => {
        const socket: net.Socket = net.connect({ host, port, timeout: 3000 });
        socket.on("connect", () => { socket.destroy(); resolve(true); });
        socket.on("timeout", () => { socket.destroy(); resolve(false); });
        socket.on("error", () => resolve(false));
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
 * Connects the live data of a started app: once the spring boot server is ready the pid of the session is sent to it
 * with the remote apps, it attaches to the local process directly and does not look for it in its list of local
 * processes. The entry is taken out again when the app stops.
 */
async function connectLive(session: Session, app: LaunchTarget): Promise<void> {
    const pid: number | undefined = session.pid;
    if (pid !== undefined && await waitFor("spring", () => session.state === "stopped")) {
        if (session.state !== "stopped") {
            await connectPid(pid, app.mainClass, app.projectName).catch(e => failed(`connect the live data of ${pid}`, e, undefined));
        }
        if (session.state === "stopped") {
            await disconnectPid(pid).catch(() => undefined);
        }
    }
}

/**
 * The key of the dashboard tab of an attached project.
 */
function attachKey(project: string): string {
    return `attach:${project}`;
}
