import * as coc from "coc.nvim";
import { Dashboard, HintNode, hintItem, hintOf, registerView } from "../dashboard";
import { LiveProcess } from "../sts";
import { config, failed } from "../util";

const BARS: string = "▁▂▃▄▅▆▇█";

/**
 * Draws the values as a line of block characters, scaled between their minimum and maximum.
 */
export function sparkline(values: number[]): string {
    const min: number = Math.min(...values);
    const range: number = Math.max(...values) - min;
    return values.map(v => BARS[range > 0 ? Math.round((v - min) / range * (BARS.length - 1)) : 0]).join("");
}

interface Series {
    label: string;
    unit: string;
    values: number[];
    extra?: string;
}

interface MemoryNode {
    kind: "app" | "series";
    key: string;
    processKey: string;
    series?: Series;
}

type MemoryElement = MemoryNode | HintNode;

const MB: number = 1024 * 1024;

/**
 * The value of a metric response: one entry per memory zone, then the committed and the max entries.
 */
function usedOf(metrics: any[]): { used: number; max?: number } {
    const zones: any[] = metrics.length > 2 ? metrics.slice(0, -2) : metrics;
    const value = (m: any) => Number(m?.measurements?.[0]?.value ?? 0);
    return { used: zones.reduce((sum, m) => sum + value(m), 0), max: metrics.length > 2 ? value(metrics[metrics.length - 1]) : undefined };
}

/**
 * The memory view: per connected process the heap, the non heap and the gc pauses as sparklines with the current
 * numbers, fed by the memory and gc pause updates of coc-springboot and polled every fetch delay.
 */
export class MemoryView implements coc.TreeDataProvider<MemoryElement>, coc.Disposable {
    private readonly data: Map<string, { name: string; heap: Series; nonHeap: Series; gc: Series }> = new Map();
    private readonly emitter = new coc.Emitter<MemoryElement | undefined>();
    public readonly onDidChangeTreeData: coc.Event<MemoryElement | undefined> = this.emitter.event;
    private readonly timer: NodeJS.Timeout;

    constructor(private readonly d: Dashboard) {
        d.appTab.onDidChange(() => this.emitter.fire(undefined));
        d.context.subscriptions.push(
            d.api.onDidLiveProcessMemoryMetricsUpdate(p => this.memory(p)),
            d.api.onDidLiveProcessGcPausesMetricsUpdate(p => this.gcPauses(p)),
            d.api.onDidLiveProcessDisconnect(p => { this.data.delete(p.processKey); this.emitter.fire(undefined); }),
        );
        this.timer = setInterval(() => this.poll(), config<number>("memory-view.fetch-data.delay-in-milliseconds", 5000));
    }

    /**
     * Asks the language server to fetch the memory and the gc pauses of each app. The data is read when the server
     * announces it (the update events of the constructor): it answers "Live Metrics Data is not yet available" before
     * the first fetch is done, and a refresh of "memory" leaves the gc pauses alone.
     */
    public async poll(): Promise<void> {
        for (const app of this.d.live.apps.values()) {
            const processKey: string = app.process.processKey;
            for (const metricName of ["memory", "gcPauses"]) {
                await this.d.api.refreshLiveProcessMetricsData({ processKey, endpoint: "metrics", metricName }).catch(e => failed(`refresh ${metricName} of ${processKey}`, e, undefined));
            }
        }
    }

    public getChildren(element?: MemoryElement): MemoryElement[] {
        // an app that disconnected while the tree is drawn has no entry any more, it renders nothing like an app without data
        const series = (key: string): MemoryNode[] => {
            const d = this.data.get(key);
            return d === undefined ? [] : [d.heap, d.nonHeap, d.gc].map(s => ({ kind: "series" as const, key: `${key}/${s.label}`, processKey: key, series: s }));
        };
        const apps: MemoryNode[] = [...this.data.keys()].map(k => ({ kind: "app", key: k, processKey: k }));
        let children: MemoryElement[];
        if (element === undefined) {
            children = apps.length > 0 ? apps : [hintOf(this.d, "memory", true)];
        } else {
            children = element.kind === "app" ? series(element.processKey) : [];
        }
        return children;
    }

    public getTreeItem(node: MemoryElement): coc.TreeItem {
        if (node.kind === "hint") {
            return hintItem(node);
        }
        const s: Series | undefined = node.series;
        const current: string = s && s.values.length > 0 ? `${s.values[s.values.length - 1].toFixed(1)} ${s.unit}` : "-";
        const extra: string = s?.extra ? ` ${s.extra}` : "";
        const values: number[] = s && s.values.length > 0 ? s.values : [0];
        const label: string = s ? `${s.label.padEnd(9)} ${sparkline(values)} ${current}${extra}` : this.data.get(node.processKey)?.name ?? node.processKey;
        const item = new coc.TreeItem(label, s ? coc.TreeItemCollapsibleState.None : coc.TreeItemCollapsibleState.Expanded);
        item.id = node.key;
        return item;
    }

    private entry(process: LiveProcess) {
        const entry = this.data.get(process.processKey) ?? {
            name: process.processName,
            heap: { label: "heap", unit: "MB", values: [] },
            nonHeap: { label: "non-heap", unit: "MB", values: [] },
            gc: { label: "gc pauses", unit: "ms", values: [] },
        };
        this.data.set(process.processKey, entry);
        return entry;
    }

    private push(series: Series, value: number): void {
        const max: number = config<number>("memory-view.display-data.max-datapoints", 10);
        series.values.push(value);
        series.values.splice(0, Math.max(0, series.values.length - max));
    }

    private async metric(process: LiveProcess, metricName: string): Promise<any[]> {
        const data = await this.d.api.getLiveProcessMetricsData({ processKey: process.processKey, endpoint: "metrics", metricName }).catch(e => failed(`${metricName} of ${process.processKey}`, e, undefined));
        return Array.isArray(data) ? data : [];
    }

    private async memory(process: LiveProcess): Promise<void> {
        const [heap, nonHeap] = [usedOf(await this.metric(process, "heapMemory")), usedOf(await this.metric(process, "nonHeapMemory"))];
        const entry = this.entry(process);
        this.push(entry.heap, heap.used / MB);
        entry.heap.extra = heap.max && heap.max > 0 ? `/ ${(heap.max / MB).toFixed(0)} MB` : undefined;
        this.push(entry.nonHeap, nonHeap.used / MB);
        this.emitter.fire(undefined);
    }

    private async gcPauses(process: LiveProcess): Promise<void> {
        const measurements: any[] = (await this.metric(process, "gcPauses")).flatMap(m => m?.measurements ?? []);
        const total = measurements.filter(m => m.statistic === "TOTAL_TIME").reduce((sum, m) => sum + Number(m.value), 0);
        const count = measurements.filter(m => m.statistic === "COUNT").reduce((sum, m) => sum + Number(m.value), 0);
        const entry = this.entry(process);
        this.push(entry.gc, total * 1000);
        entry.gc.extra = `(count ${count})`;
        this.emitter.fire(undefined);
    }

    public dispose(): void {
        clearInterval(this.timer);
    }
}

export function registerMemory(d: Dashboard): MemoryView {
    const provider = new MemoryView(d);
    registerView(d, "spring.memoryView", "SPRING MEMORY", provider, { component: "memory" });
    d.context.subscriptions.push(provider);
    return provider;
}
