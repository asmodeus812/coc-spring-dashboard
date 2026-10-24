import * as coc from "coc.nvim";
import { sleep } from "./util";

/**
 * A live process as coc-springboot reports it, the key is `<pid> - <main class>` for local processes.
 */
export interface LiveProcess {
    type: string;
    processKey: string;
    processName: string;
    pid?: string;
}

export interface LiveQuery {
    processKey: string;
    endpoint: string;
    metricName?: string;
    beanName?: string;
    dependingOn?: string;
}

export interface IndexBean {
    name: string;
    type: string;
    location: coc.Location;
    injectionPoints?: { name: string; type: string; location: coc.Location }[];
    supertypes?: string[];
}

/**
 * The extension api that coc-springboot exports, the subset the dashboard uses.
 */
export interface StsApi {
    client: coc.LanguageClient;
    onDidLiveProcessConnect: coc.Event<LiveProcess>;
    onDidLiveProcessDisconnect: coc.Event<LiveProcess>;
    onDidLiveProcessUpdate: coc.Event<LiveProcess>;
    onDidLiveProcessGcPausesMetricsUpdate: coc.Event<LiveProcess>;
    onDidLiveProcessMemoryMetricsUpdate: coc.Event<LiveProcess>;
    getLiveProcessData(query: LiveQuery): Promise<any>;
    refreshLiveProcessData(query: LiveQuery): Promise<any>;
    getLiveProcessMetricsData(query: LiveQuery): Promise<any>;
    refreshLiveProcessMetricsData(query: LiveQuery): Promise<any>;
    listConnectedProcesses(): Promise<LiveProcess[]>;
    getSpringIndex(): { beans(params: { projectName: string }): Promise<IndexBean[]>; onSpringIndexUpdated: coc.Event<any> };
}

/**
 * Waits until coc-java and coc-springboot are active and returns the api of coc-springboot, undefined when either never
 * shows up. A runtime check instead of extensionDependencies, with which coc silently skips the activation when one is missing.
 */
export async function waitForStsApi(timeout: number = 300000): Promise<StsApi | undefined> {
    const started: number = Date.now();
    let api: StsApi | undefined = undefined;
    while (api === undefined && Date.now() - started < timeout) {
        const ext = coc.extensions.all.find(e => e.id === "coc-springboot");
        const java = coc.extensions.all.find(e => e.id === "coc-java");
        const bothActive: boolean = java?.isActive === true && ext?.isActive === true;
        const exported: StsApi | undefined = ext?.exports as StsApi | undefined;
        if (bothActive && exported?.client) {
            api = exported;
        } else {
            await sleep(500);
        }
    }
    return api;
}

/**
 * The main class of a live process, upstream's fallback is the process name.
 */
export function mainClassOf(process: LiveProcess): string {
    return process.processKey.split(" - ")[1] ?? process.processName;
}
