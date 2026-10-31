import * as coc from "coc.nvim";
import { LiveProcess, StsApi, mainClassOf } from "./sts";
import { failed } from "./util";

export interface PropertyGroup {
    name: string;
    properties: { name: string; value: string }[];
}

/**
 * What a connected process reports: beans, mappings, the port and the context path, the properties on demand.
 */
export interface LiveApp {
    process: LiveProcess;
    mainClass: string;
    beans: string[];
    mappings: any[];
    port?: number;
    contextPath?: string;
    properties?: PropertyGroup[];
}

const RELOAD_ATTEMPTS = 20;
const RELOAD_DELAY_MS = 3000;

/**
 * The live data of all connected processes, kept up to date from the live process events of coc-springboot.
 */
export class LiveData implements coc.Disposable {
    public readonly apps: Map<string, LiveApp> = new Map();
    private readonly emitter = new coc.Emitter<LiveApp | undefined>();
    public readonly onDidChange: coc.Event<LiveApp | undefined> = this.emitter.event;
    private readonly disposables: coc.Disposable[] = [];
    private readonly reloads: Map<string, number> = new Map();

    constructor(public readonly api: StsApi) {
        this.disposables.push(
            api.onDidLiveProcessConnect(p => this.load(p)),
            api.onDidLiveProcessUpdate(p => this.load(p)),
            api.onDidLiveProcessDisconnect(p => this.remove(p)),
        );
    }

    public async init(): Promise<void> {
        const processes: LiveProcess[] = (await this.api.listConnectedProcesses().catch(e => failed("list connected processes", e, []))) ?? [];
        await Promise.all(processes.map(p => this.load(p)));
    }

    /**
     * Refreshes the live data of every connected app, `report` tells the user when there is none or a refresh fails.
     */
    public async refresh(report: boolean = false): Promise<void> {
        if (report && this.apps.size === 0) {
            coc.window.showWarningMessage("No connected app to refresh, run an app or connect a remote one");
        } else {
            let errors: number = 0;
            await Promise.all([...this.apps.values()].map(a => this.api.refreshLiveProcessData({ processKey: a.process.processKey, endpoint: "beans" }).catch(e => { errors++; return failed(`refresh ${a.process.processKey}`, e, undefined); })));
            await this.init();
            if (report && errors > 0) {
                coc.window.showErrorMessage(`Spring Boot Dashboard: the live data of ${errors} app${errors === 1 ? "" : "s"} could not be refreshed, see the Spring Dashboard output`);
            }
        }
    }

    public byMainClass(mainClass: string): LiveApp | undefined {
        return [...this.apps.values()].find(a => a.mainClass === mainClass);
    }

    public byPid(pid: number): LiveApp | undefined {
        return [...this.apps.values()].find(a => a.process.pid === String(pid));
    }

    public async properties(app: LiveApp): Promise<PropertyGroup[]> {
        if (app.properties === undefined) {
            const payload = await this.query(app.process, "properties");
            app.properties = (payload?.sources ?? []).map((source: any) => ({
                name: source.sourceName,
                properties: (source.properties ?? []).map((p: any) => ({ name: p.property, value: String(p.value) })),
            }));
        }
        return app.properties ?? [];
    }

    public async beanDetail(app: LiveApp, beanName: string): Promise<any[]> {
        const detail = await this.api.getLiveProcessData({ processKey: app.process.processKey, endpoint: "beans", beanName }).catch(e => failed(`bean ${beanName}`, e, undefined));
        return Array.isArray(detail) ? detail : [];
    }

    public async beansDependingOn(app: LiveApp, beanName: string): Promise<any[]> {
        const beans = await this.api.getLiveProcessData({ processKey: app.process.processKey, endpoint: "beans", dependingOn: beanName }).catch(e => failed(`beans depending on ${beanName}`, e, undefined));
        return Array.isArray(beans) ? beans : [];
    }

    private async query(process: LiveProcess, endpoint: string): Promise<any> {
        return this.api.getLiveProcessData({ processKey: process.processKey, endpoint }).catch(e => failed(`${endpoint} of ${process.processKey}`, e, undefined));
    }

    private async load(process: LiveProcess): Promise<void> {
        const [beans, mappings, port, contextPath] = await Promise.all(["beans", "mappings", "port", "contextPath"].map(e => this.query(process, e)));
        const app: LiveApp = {
            process,
            mainClass: mainClassOf(process),
            beans: (Array.isArray(beans) ? beans : []).map((b: any) => typeof b === "string" ? b : (b?.id ?? b?.name ?? String(b))).sort(),
            mappings: Array.isArray(mappings) ? mappings : [],
            port: port ? parseInt(String(port), 10) : undefined,
            contextPath: contextPath ? String(contextPath) : undefined,
        };
        this.apps.set(process.processKey, app);
        this.emitter.fire(app);
        if (app.port === undefined) {
            this.reloadLater(process);
        } else {
            this.reloads.delete(process.processKey);
        }
    }

    /**
     * A process connected a moment ago has not gathered its live data yet, its port comes back empty and no update
     * follows on its own: the data is refreshed and loaded again for a while, until the port is there or the process is
     * gone.
     */
    private reloadLater(process: LiveProcess): void {
        const attempts: number = (this.reloads.get(process.processKey) ?? 0) + 1;
        if (attempts <= RELOAD_ATTEMPTS) {
            this.reloads.set(process.processKey, attempts);
            setTimeout(async () => {
                if (this.apps.has(process.processKey)) {
                    await this.api.refreshLiveProcessData({ processKey: process.processKey, endpoint: "port" }).catch(e => failed(`refresh ${process.processKey}`, e, undefined));
                    await this.load(process);
                }
            }, RELOAD_DELAY_MS);
        } else {
            this.reloads.delete(process.processKey);
        }
    }

    private remove(process: LiveProcess): void {
        this.apps.delete(process.processKey);
        this.reloads.delete(process.processKey);
        this.emitter.fire(undefined);
    }

    public dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.emitter.dispose();
    }
}
