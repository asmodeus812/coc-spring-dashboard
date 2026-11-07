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

const RELOAD_DELAYS_MS = [3000, 6000, 12000];
const RELOAD_MAX_MS = 120000;

/**
 * The live data of all connected processes, kept up to date from the live process events of coc-springboot.
 */
export class LiveData implements coc.Disposable {
    public readonly apps: Map<string, LiveApp> = new Map();
    private readonly emitter = new coc.Emitter<LiveApp | undefined>();
    public readonly onDidChange: coc.Event<LiveApp | undefined> = this.emitter.event;
    private readonly disposables: coc.Disposable[] = [];
    private readonly reloads: Map<string, NodeJS.Timeout> = new Map();
    /** Whether a dashboard view is on screen, set by the apps view; a refresh tells the user when it is not. */
    public onScreen: () => boolean = () => false;
    private listFailed: boolean = false;

    constructor(public readonly api: StsApi) {
        this.disposables.push(
            api.onDidLiveProcessConnect(p => this.load(p)),
            api.onDidLiveProcessUpdate(p => this.load(p)),
            api.onDidLiveProcessDisconnect(p => this.remove(p)),
        );
    }

    public async init(): Promise<void> {
        this.listFailed = false;
        const processes: LiveProcess[] = (await this.api.listConnectedProcesses().catch(e => { this.listFailed = true; return failed("list connected processes", e, []); })) ?? [];
        await Promise.all(processes.map(p => this.load(p)));
    }

    /**
     * Refreshes the live data of every connected app, `report` tells the user when there is none or a refresh fails.
     */
    public async refresh(report: boolean = false): Promise<void> {
        if (report && this.apps.size === 0) {
            coc.window.showWarningMessage("No connected app");
        } else {
            let errors: number = 0;
            await Promise.all([...this.apps.values()].map(a => this.api.refreshLiveProcessData({ processKey: a.process.processKey, endpoint: "beans" }).catch(e => { errors++; return failed(`refresh ${a.process.processKey}`, e, undefined); })));
            await this.init();
            if (report && (errors > 0 || this.listFailed)) {
                coc.window.showErrorMessage("Live data not refreshed");
            } else if (report && !this.onScreen()) {
                coc.window.showInformationMessage(`Refreshed ${this.apps.size} app${this.apps.size === 1 ? "" : "s"}`);
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
            // Spring Boot 3 masks the values of the env endpoint ("******") unless show-values allows them
            contextPath: String(contextPath ?? "").startsWith("/") ? String(contextPath) : undefined,
        };
        this.apps.set(process.processKey, app);
        this.emitter.fire(app);
        if (app.port === undefined) {
            this.reloadLater(process);
        } else {
            this.cancelReload(process.processKey);
        }
    }

    /**
     * A process connected a moment ago has not gathered its live data yet, its port comes back empty and no update
     * follows on its own: only the port is asked for, with a growing delay and for two minutes at most, one chain per
     * process. The full load follows once the port is there.
     */
    private reloadLater(process: LiveProcess): void {
        if (!this.reloads.has(process.processKey)) {
            this.scheduleReload(process, Date.now(), 0);
        }
    }

    private scheduleReload(process: LiveProcess, since: number, attempt: number): void {
        const key: string = process.processKey;
        const delay: number = RELOAD_DELAYS_MS[Math.min(attempt, RELOAD_DELAYS_MS.length - 1)];
        if (Date.now() + delay - since > RELOAD_MAX_MS) {
            this.reloads.delete(key);
        } else {
            this.reloads.set(key, setTimeout(() => this.reloadTick(process, since, attempt), delay));
        }
    }

    private async reloadTick(process: LiveProcess, since: number, attempt: number): Promise<void> {
        const key: string = process.processKey;
        const stillConnected: boolean = this.apps.has(key);
        if (stillConnected) {
            await this.api.refreshLiveProcessData({ processKey: key, endpoint: "port" }).catch(e => failed(`refresh ${key}`, e, undefined));
            const port: unknown = await this.query(process, "port");
            // unless the process went away meanwhile
            const stillWaiting: boolean = this.reloads.has(key);
            if (stillWaiting && port) {
                this.reloads.delete(key);
                await this.load(process);
            } else if (stillWaiting) {
                this.scheduleReload(process, since, attempt + 1);
            }
        } else {
            this.reloads.delete(key);
        }
    }

    private cancelReload(key: string): void {
        const timer: NodeJS.Timeout | undefined = this.reloads.get(key);
        if (timer !== undefined) {
            clearTimeout(timer);
        }
        this.reloads.delete(key);
    }

    private remove(process: LiveProcess): void {
        this.apps.delete(process.processKey);
        this.cancelReload(process.processKey);
        this.emitter.fire(undefined);
    }

    public dispose(): void {
        [...this.reloads.keys()].forEach(k => this.cancelReload(k));
        this.disposables.forEach(d => d.dispose());
        this.emitter.dispose();
    }
}
