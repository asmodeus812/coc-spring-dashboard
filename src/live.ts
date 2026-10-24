import * as coc from "coc.nvim";
import { LiveProcess, StsApi, mainClassOf } from "./sts";

let channel: coc.OutputChannel | undefined;

/**
 * Logs a failed live request to the "Spring Dashboard" output channel and answers the fallback, so the views keep
 * their last data and no notification is raised.
 */
export function failed<T>(request: string, error: unknown, fallback: T): T {
    channel = channel ?? coc.window.createOutputChannel("Spring Dashboard");
    channel.appendLine(`[${new Date().toISOString()}] ${request} failed: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
}

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

/**
 * The live data of all connected processes, kept up to date from the live process events of coc-springboot.
 */
export class LiveData implements coc.Disposable {
    public readonly apps: Map<string, LiveApp> = new Map();
    private readonly emitter = new coc.Emitter<LiveApp | undefined>();
    public readonly onDidChange: coc.Event<LiveApp | undefined> = this.emitter.event;
    private readonly disposables: coc.Disposable[] = [];

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

    public async refresh(): Promise<void> {
        await Promise.all([...this.apps.values()].map(a => this.api.refreshLiveProcessData({ processKey: a.process.processKey, endpoint: "beans" }).catch(e => failed(`refresh ${a.process.processKey}`, e, undefined))));
        await this.init();
    }

    public byMainClass(mainClass: string): LiveApp | undefined {
        return [...this.apps.values()].find(a => a.mainClass === mainClass);
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
    }

    private remove(process: LiveProcess): void {
        this.apps.delete(process.processKey);
        this.emitter.fire(undefined);
    }

    public dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.emitter.dispose();
    }
}
