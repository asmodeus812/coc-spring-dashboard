import * as coc from "coc.nvim";
import * as fs from "fs";
import { Dashboard, TREE_SPLIT, registerView, stateIcon } from "./dashboard";
import { AppLauncher, LaunchTarget } from "./launch";
import { LiveApp, LiveData } from "./live";
import { formatUrl, openUrl, projectRoot } from "./util";

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
 * The apps view and its commands. The state of an app is running when a live process of its main class is connected,
 * whoever started it.
 */
export class AppsView implements coc.TreeDataProvider<BootApp> {
    public apps: BootApp[] = [];
    private readonly emitter = new coc.Emitter<BootApp | undefined>();
    public readonly onDidChangeTreeData: coc.Event<BootApp | undefined> = this.emitter.event;

    constructor(private readonly live: LiveData, private readonly launcher: AppLauncher) {
        live.onDidChange(() => this.emitter.fire(undefined));
    }

    public async refresh(): Promise<BootApp[]> {
        const found: MainClassData[] = ((await coc.commands.executeCommand("java.execute.workspaceCommand", "vscode.java.resolveMainClass").catch(() => [])) as MainClassData[]) ?? [];
        this.apps = found
            .filter(m => m.filePath && fs.existsSync(m.filePath) && fs.readFileSync(m.filePath, "utf8").includes("@SpringBootApplication"))
            .map(m => this.apps.find(a => a.mainClass === m.mainClass) ?? new BootApp(m.projectName, m.mainClass, m.projectName, projectRoot(m.filePath)))
            .sort((a, b) => a.name.localeCompare(b.name));
        this.emitter.fire(undefined);
        return this.apps;
    }

    public liveOf(app: BootApp): LiveApp | undefined {
        return this.live.byMainClass(app.mainClass);
    }

    public getChildren(element?: BootApp): BootApp[] {
        return element ? [] : this.apps;
    }

    public getTreeItem(app: BootApp): coc.TreeItem {
        const live: LiveApp | undefined = this.liveOf(app);
        const item = new coc.TreeItem(app.name, coc.TreeItemCollapsibleState.None);
        item.id = app.mainClass;
        item.icon = stateIcon(live !== undefined);
        item.description = live ? `running${live.port ? ` :${live.port}` : ""}` : "stopped";
        item.tooltip = app.mainClass;
        return item;
    }

    public resolveActions(_item: coc.TreeItem, app: BootApp): coc.TreeItemAction<BootApp>[] {
        return [
            { title: "Run", handler: a => this.run(a) },
            { title: "Run with profile", handler: a => this.runWithProfile(a) },
            { title: "Debug", handler: a => this.debug(a) },
            { title: "Debug with profile", handler: a => this.debugWithProfile(a) },
            { title: "Stop", handler: a => this.stop(a) },
            ...(this.liveOf(app) ? [{ title: "Open in browser", handler: (a: BootApp) => this.open(a) }] : []),
        ].map(a => ({ title: a.title, handler: async (x: BootApp) => { await a.handler(x); } }));
    }

    public async run(arg?: BootApp | string, profile?: string): Promise<string | undefined> {
        const app = await this.resolve(arg);
        return app ? this.launcher.run(app, profile) : undefined;
    }

    public async runWithProfile(arg?: BootApp | string, profile?: string): Promise<string | undefined> {
        const app = await this.resolve(arg);
        const chosen = app ? await this.askProfile(profile) : undefined;
        return app && chosen !== undefined ? this.launcher.run(app, chosen) : undefined;
    }

    public async debug(arg?: BootApp | string, profile?: string): Promise<string | undefined> {
        const app = await this.resolve(arg);
        return app ? this.launcher.debug(app, profile) : undefined;
    }

    public async debugWithProfile(arg?: BootApp | string, profile?: string): Promise<string | undefined> {
        const app = await this.resolve(arg);
        const chosen = app ? await this.askProfile(profile) : undefined;
        return app && chosen !== undefined ? this.launcher.debug(app, chosen) : undefined;
    }

    public async stop(arg?: BootApp | string): Promise<string | undefined> {
        const app = await this.resolve(arg, true);
        return app ? this.launcher.stop(app) : undefined;
    }

    public async open(arg?: BootApp | string): Promise<string | undefined> {
        const app = await this.resolve(arg, true);
        const live = app ? this.liveOf(app) : undefined;
        return live ? openUrl(formatUrl(live.port, live.contextPath)) : undefined;
    }

    public async multiple(operation: "run" | "debug" | "stop", names?: string[]): Promise<string[]> {
        const candidates = this.apps.filter(a => operation === "stop" ? this.liveOf(a) : !this.liveOf(a));
        const picked: BootApp[] = names
            ? candidates.filter(a => names.includes(a.name))
            : ((await coc.window.showQuickPick(candidates.map(a => ({ label: a.name, app: a })), { canPickMany: true, title: `Select apps to ${operation}` })) ?? []).map(p => p.app);
        const results: string[] = [];
        for (const app of picked) {
            results.push(await (operation === "stop" ? this.launcher.stop(app) : this.launcher[operation](app)));
        }
        return results;
    }

    private async askProfile(profile?: string): Promise<string | undefined> {
        return profile ?? coc.window.requestInput("Active profiles (comma separated)");
    }

    /**
     * The app of a command argument: the tree element, an app name, or a pick from the apps (running ones only for
     * the operations that need a running app).
     */
    private async resolve(arg?: BootApp | string, running: boolean = false): Promise<BootApp | undefined> {
        const candidates = this.apps.filter(a => !running || this.liveOf(a));
        const named = typeof arg === "string" ? this.apps.find(a => a.name === arg || a.mainClass === arg) : arg;
        const picked = named ?? (candidates.length === 1 ? candidates[0] : (await coc.window.showQuickPick(candidates.map(a => ({ label: a.name, app: a })), { title: "Select an app" }))?.app);
        return picked;
    }
}

/**
 * Registers the apps tree, the local app commands and the live data refresh. The apps are resolved again until coc-java
 * finds them, the language server needs some time after startup.
 */
export function registerApps(d: Dashboard): AppsView {
    const provider: AppsView = d.apps;
    const view = registerView(d, "spring.apps", "SPRING APPS", provider);
    const id = (name: string) => `spring-boot-dashboard.${name}`;
    d.context.subscriptions.push(
        coc.commands.registerCommand(id("apps.show"), () => view.show(TREE_SPLIT)),
        coc.commands.registerCommand(id("refresh"), () => provider.refresh()),
        coc.commands.registerCommand(id("localapp.run"), (arg?: BootApp | string, profile?: string) => provider.run(arg, profile)),
        coc.commands.registerCommand(id("localapp.runWithProfile"), (arg?: BootApp | string, profile?: string) => provider.runWithProfile(arg, profile)),
        coc.commands.registerCommand(id("localapp.debug"), (arg?: BootApp | string, profile?: string) => provider.debug(arg, profile)),
        coc.commands.registerCommand(id("localapp.debugWithProfile"), (arg?: BootApp | string, profile?: string) => provider.debugWithProfile(arg, profile)),
        coc.commands.registerCommand(id("localapp.stop"), (arg?: BootApp | string) => provider.stop(arg)),
        coc.commands.registerCommand(id("localapp.open"), (arg?: BootApp | string) => provider.open(arg)),
        coc.commands.registerCommand(id("localapp.run-multiple"), (names?: string[]) => provider.multiple("run", names)),
        coc.commands.registerCommand(id("localapp.debug-multiple"), (names?: string[]) => provider.multiple("debug", names)),
        coc.commands.registerCommand(id("localapp.stop-multiple"), (names?: string[]) => provider.multiple("stop", names)),
        coc.commands.registerCommand("spring.dashboard.livedata.refresh", () => d.live.refresh()),
    );
    const resolve = async (attempt: number): Promise<void> => {
        const apps: BootApp[] = await provider.refresh();
        if (apps.length === 0 && attempt < 60) {
            setTimeout(() => { resolve(attempt + 1).catch(() => undefined); }, 5000);
        }
    };
    resolve(0).catch(() => undefined);
    return provider;
}
