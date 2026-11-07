import * as coc from "coc.nvim";
import * as fs from "node:fs";
import * as path from "node:path";
import { Dashboard, focusView, registerView, stateIcon } from "./dashboard";
import { AppLauncher, AppState, AttachProject, LaunchTarget } from "./launch";
import { LiveApp, LiveData } from "./live";
import { attachedAddress, onDidChangeRemote } from "./remote";
import { need, ready, waitFor } from "./ready";
import { failed, formatUrl, javaCommand, openUrl, projectRoot } from "./util";

/** Which apps a command can act on: any, the stopped ones, the running ones, the running ones without a debugger, those with a dashboard. */
type AppFilter = "any" | "stopped" | "running" | "attachable" | "output";

const NOTHING_TO_PICK: Record<AppFilter, string> = {
    any: "No Spring Boot app found",
    stopped: "Every app is running",
    running: "No app is running",
    attachable: "No app is running",
    output: "No app dashboard",
};

/**
 * A spring boot app of the workspace: a main class annotated with `@SpringBootApplication`.
 */
export class BootApp implements LaunchTarget {
    constructor(
        public readonly name: string,
        public readonly mainClass: string,
        public readonly projectName: string,
        public readonly path: string,
    ) { }
}

interface MainClassData {
    mainClass: string;
    projectName: string;
    filePath: string;
}

/**
 * The apps view and its commands. The state of an app is the launcher's for an app the dashboard started, running for any
 * other app with a live process.
 */
export class AppsView implements coc.TreeDataProvider<BootApp> {
    public apps: BootApp[] = [];
    private readonly emitter = new coc.Emitter<BootApp | undefined>();
    public readonly onDidChangeTreeData: coc.Event<BootApp | undefined> = this.emitter.event;

    constructor(private readonly live: LiveData, private readonly launcher: AppLauncher) {
        live.onDidChange(() => this.emitter.fire(undefined));
        onDidChangeRemote(() => this.emitter.fire(undefined));
        launcher.onDidChangeState(() => this.emitter.fire(undefined));
    }

    /**
     * Whether the apps view is on screen, set by the registration. A change the view shows needs no message.
     */
    public onScreen: () => boolean = () => false;

    private notify(message: string): void {
        if (!this.onScreen()) {
            void coc.window.showInformationMessage(message);
        }
    }

    /**
     * Resolves the apps again, `report` (the command, not the retry timer) tells the user when that fails or finds none.
     */
    public async refresh(report: boolean = false): Promise<BootApp[]> {
        if (report ? need("java") : ready("java")) {
            await this.load(report);
        }
        return this.apps;
    }

    private async load(report: boolean): Promise<void> {
        let found: MainClassData[] = [];
        let error: string | undefined;
        try {
            found = (await javaCommand<MainClassData[]>("vscode.java.resolveMainClass")) ?? [];
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }
        this.apps = found
            .filter(m => m.filePath && fs.existsSync(m.filePath) && fs.readFileSync(m.filePath, "utf8").includes("@SpringBootApplication"))
            .map(m => this.apps.find(a => a.mainClass === m.mainClass) ?? new BootApp(m.projectName, m.mainClass, m.projectName, projectRoot(m.filePath)))
            .sort((a, b) => a.name.localeCompare(b.name));
        this.emitter.fire(undefined);
        if (report && error !== undefined) {
            failed("resolve the apps", error, undefined);
            void coc.window.showErrorMessage("Apps not resolved");
        } else if (report && this.apps.length === 0) {
            void coc.window.showWarningMessage(NOTHING_TO_PICK.any);
        } else if (report) {
            this.notify(`Found ${this.apps.length} app${this.apps.length === 1 ? "" : "s"}`);
        }
    }

    public liveOf(app: BootApp): LiveApp | undefined {
        const pid: number | undefined = this.launcher.pidOf(app);
        const started: boolean = this.launcher.state(app) !== "stopped";
        // an app the dashboard started is paired by pid only, a JVM waiting for a debugger has no main class yet
        let live: LiveApp | undefined;
        if (pid !== undefined) {
            live = this.live.byPid(pid);
        } else if (started) {
            live = undefined;
        } else {
            live = this.live.byMainClass(app.mainClass);
        }
        return live;
    }

    /**
     * The launcher's state for an app the dashboard started, otherwise running with a live process on this machine, or
     * attached when Attach to a remote app connected its project.
     */
    public stateOf(app: BootApp): AppState {
        let state: AppState = this.launcher.state(app);
        if (state === "stopped" && this.liveOf(app)) {
            state = "running";
        } else if (state === "stopped" && attachedAddress(app.projectName) !== undefined) {
            state = "attached";
        }
        return state;
    }

    /**
     * Whether an app of the workspace by this name is starting, running or stopping.
     */
    public isStarted(name: string): boolean {
        return this.apps.some(a => a.name === name && this.stateOf(a) !== "stopped");
    }

    // the state of an app with its port, as the tree and the app picker show it
    private describe(app: BootApp): string {
        const state: AppState = this.stateOf(app);
        const port: number | undefined = this.liveOf(app)?.port;
        const portText: string = port ? ` :${port}` : "";
        let text: string = `${state}${portText}`;
        if (state === "waiting") {
            text = "waiting for debugger";
        } else if (state === "attached") {
            text = `attached ${attachedAddress(app.projectName)}`;
        }
        return text;
    }

    public getChildren(element?: BootApp): BootApp[] {
        return element ? [] : this.apps;
    }

    public getTreeItem(app: BootApp): coc.TreeItem {
        const item = new coc.TreeItem(app.name, coc.TreeItemCollapsibleState.None);
        item.id = app.mainClass;
        item.icon = stateIcon(this.stateOf(app));
        item.description = this.describe(app);
        item.tooltip = app.mainClass;
        return item;
    }

    /**
     * The actions of an app, those that fit its state: a stopped app starts, a started one stops, shows its dashboard,
     * takes the debugger; an attached app runs elsewhere and has none of them.
     */
    public resolveActions(_item: coc.TreeItem, app: BootApp): coc.TreeItemAction<BootApp>[] {
        const state: AppState = this.stateOf(app);
        const stopped: boolean = state === "stopped";
        const startedHere: boolean = this.launcher.state(app) !== "stopped";
        return [
            { title: "Run", when: stopped, handler: (a: BootApp) => this.run(a) },
            { title: "Run with profile", when: stopped, handler: (a: BootApp) => this.runWithProfile(a) },
            { title: "Debug", when: stopped, handler: (a: BootApp) => this.debug(a) },
            { title: "Debug with profile", when: stopped, handler: (a: BootApp) => this.debugWithProfile(a) },
            { title: "Launch settings...", when: state !== "attached", handler: (a: BootApp) => this.settings(a) },
            { title: "Show app dashboard", when: startedHere, handler: (a: BootApp) => this.output(a) },
            { title: "Stop", when: !stopped && state !== "attached", handler: (a: BootApp) => this.stop(a) },
            { title: "Attach debugger", when: this.launcher.state(app) === "running", handler: (a: BootApp) => this.attach(a) },
            { title: "Open in browser", when: this.liveOf(app) !== undefined, handler: (a: BootApp) => this.open(a) },
        ].filter(a => a.when).map(a => ({ title: a.title, handler: async (x: BootApp) => { await a.handler(x); } }));
    }

    public async run(arg?: BootApp | string, profile?: string): Promise<string | undefined> {
        const app = need("java") ? await this.resolve(arg, "stopped") : undefined;
        return app ? this.launcher.run(app, { profile }) : undefined;
    }

    /**
     * The "with profile" commands open the launch panel with the profiles first, a profile argument skips that.
     */
    public async runWithProfile(arg?: BootApp | string, profile?: string): Promise<string | undefined> {
        const app = need("java") ? await this.resolve(arg, "stopped") : undefined;
        return app ? this.launcher.run(app, { profile, pickProfiles: profile === undefined }) : undefined;
    }

    public async debug(arg?: BootApp | string, profile?: string): Promise<string | undefined> {
        const app = need("java") ? await this.resolve(arg, "stopped") : undefined;
        return app ? this.launcher.debug(app, { profile }) : undefined;
    }

    public async debugWithProfile(arg?: BootApp | string, profile?: string): Promise<string | undefined> {
        const app = need("java") ? await this.resolve(arg, "stopped") : undefined;
        return app ? this.launcher.debug(app, { profile, pickProfiles: profile === undefined }) : undefined;
    }

    public async settings(arg?: BootApp | string): Promise<string | undefined> {
        const app = need("java") ? await this.resolve(arg) : undefined;
        return app ? this.launcher.configure(app) : undefined;
    }

    public async output(arg?: BootApp | string): Promise<string | undefined> {
        const app = await this.resolve(arg, "output");
        return app ? this.launcher.showOutput(app) : undefined;
    }

    public async attach(arg?: BootApp | string): Promise<string | undefined> {
        const app = need("java") ? await this.resolve(arg, "attachable") : undefined;
        return app ? this.launcher.attach(app) : undefined;
    }

    /**
     * The attach command: the panel, or the options (host, JMX port, debug port, project) to skip it. The projects to pick
     * from are the Java projects of the workspace.
     */
    public async attachApp(host?: string, jmxPort?: string, debugPort?: string, project?: string): Promise<string | undefined> {
        const projects: AttachProject[] = this.apps.map(a => ({ name: a.projectName, path: a.path }));
        if (ready("java")) {
            const uris: string[] = ((await javaCommand<string[]>("java.project.getAll").catch(() => [])) ?? []);
            for (const uri of uris) {
                const folder: string = coc.Uri.parse(uri).fsPath;
                const name: string = path.basename(folder);
                if (!projects.some(p => p.name === name)) {
                    projects.push({ name, path: folder });
                }
            }
        }
        return this.launcher.attachRemote({ host, jmxPort, debugPort, project }, projects);
    }

    public async stop(arg?: BootApp | string): Promise<string | undefined> {
        const app = await this.resolve(arg, "running");
        return app ? this.stopApp(app) : undefined;
    }

    /**
     * Stops an app, one that the dashboard did not start by the pid of its live process.
     */
    private async stopApp(app: BootApp): Promise<string> {
        const pid: string | undefined = this.liveOf(app)?.process.pid;
        const result: string = await this.launcher.stop(app, pid ? Number.parseInt(pid, 10) : undefined);
        if (result.startsWith("Stopping ")) {
            this.notify(result);
        }
        return result;
    }

    public async open(arg?: BootApp | string): Promise<string | undefined> {
        const app = await this.resolve(arg, "running");
        const live = app ? this.liveOf(app) : undefined;
        if (app && !live) {
            void coc.window.showWarningMessage(`${app.name} not connected`);
        }
        return live ? openUrl(formatUrl(live.port, live.contextPath)) : undefined;
    }

    /**
     * The app a command acts on: the one it was given, otherwise the only app the command can act on, otherwise the one
     * picked from those; the picker shows the state and the port of each app. Nothing to act on says so.
     */
    private async resolve(arg?: BootApp | string, which: AppFilter = "any"): Promise<BootApp | undefined> {
        // right after startup the background lookup may not have found the apps yet: look now
        if (this.apps.length === 0) {
            await this.load(false);
        }
        let picked: BootApp | undefined = typeof arg === "string" ? this.apps.find(a => a.name === arg || a.mainClass === arg) : arg;
        // an app attached as a remote app runs elsewhere: Run and Debug would start a second copy of it
        const attached: boolean = picked !== undefined && which === "stopped" && this.stateOf(picked) === "attached";
        if (attached) {
            void coc.window.showWarningMessage(`${picked?.name} is attached as a remote app`);
            picked = undefined;
        } else if (picked === undefined && this.apps.length === 0) {
            void coc.window.showWarningMessage(NOTHING_TO_PICK.any);
        } else if (picked === undefined) {
            picked = await this.pick(which);
        }
        return picked;
    }

    /**
     * The only app `which` accepts, otherwise the one picked from those it accepts; none accepted says so.
     */
    private async pick(which: AppFilter): Promise<BootApp | undefined> {
        const candidates: BootApp[] = [];
        for (const app of this.apps) {
            if (await this.accepts(app, which)) {
                candidates.push(app);
            }
        }
        let picked: BootApp | undefined;
        if (candidates.length === 0) {
            void coc.window.showWarningMessage(NOTHING_TO_PICK[which]);
        } else if (candidates.length === 1) {
            picked = candidates[0];
        } else {
            const items = candidates.map(a => ({ label: a.name, description: this.describe(a), app: a }));
            picked = (await coc.window.showQuickPick(items, { title: "Select an app", matchOnDescription: true }))?.app;
        }
        return picked;
    }

    private async accepts(app: BootApp, which: AppFilter): Promise<boolean> {
        const state: AppState = this.stateOf(app);
        let accepted: boolean;
        if (which === "stopped") {
            accepted = state === "stopped";
        } else if (which === "running") {
            accepted = state !== "stopped" && state !== "attached";
        } else if (which === "attachable") {
            accepted = state === "running";
        } else if (which === "output") {
            accepted = await this.launcher.hasOutput(app);
        } else {
            accepted = true;
        }
        return accepted;
    }
}

/**
 * Registers the apps tree, the local app commands and the live data refresh. The apps are resolved again until coc-java
 * finds them, the language server needs some time after startup.
 */
export function registerApps(d: Dashboard): AppsView {
    const provider: AppsView = d.apps;
    const view = registerView(d, "spring.apps", "SPRING APPS", provider);
    provider.onScreen = () => view.visible;
    d.live.onScreen = () => [...d.views.values()].some(v => v.visible);
    const id = (name: string) => `spring-boot-dashboard.${name}`;
    d.context.subscriptions.push(
        coc.commands.registerCommand(id("list"), () => focusView(view)),
        coc.commands.registerCommand(id("refresh"), () => provider.refresh(true)),
        coc.commands.registerCommand(id("app.local.run"), (arg?: BootApp | string, profile?: string) => provider.run(arg, profile)),
        coc.commands.registerCommand(id("app.local.runWithProfile"), (arg?: BootApp | string, profile?: string) => provider.runWithProfile(arg, profile), undefined, true),
        coc.commands.registerCommand(id("app.local.debug"), (arg?: BootApp | string, profile?: string) => provider.debug(arg, profile)),
        coc.commands.registerCommand(id("app.local.debugWithProfile"), (arg?: BootApp | string, profile?: string) => provider.debugWithProfile(arg, profile), undefined, true),
        coc.commands.registerCommand(id("app.local.settings"), (arg?: BootApp | string) => provider.settings(arg)),
        coc.commands.registerCommand(id("app.local.dashboard"), (arg?: BootApp | string) => provider.output(arg)),
        coc.commands.registerCommand(id("app.local.attach"), (arg?: BootApp | string) => provider.attach(arg)),
        coc.commands.registerCommand(id("app.remote.attach"), (host?: string, jmxPort?: string, debugPort?: string, project?: string) => provider.attachApp(host, jmxPort, debugPort, project)),
        coc.commands.registerCommand(id("app.local.stop"), (arg?: BootApp | string) => provider.stop(arg)),
        coc.commands.registerCommand(id("app.local.open"), (arg?: BootApp | string) => provider.open(arg)),
        coc.commands.registerCommand(id("livedata.refresh"), () => need("spring") ? d.live.refresh(true) : undefined),
    );
    const resolve = async (attempt: number): Promise<void> => {
        const apps: BootApp[] = await provider.refresh();
        if (apps.length === 0 && attempt < 60) {
            setTimeout(() => { resolve(attempt + 1).catch(() => undefined); }, 5000);
        }
    };
    waitFor("java").then(() => resolve(0)).catch(() => undefined);
    return provider;
}
