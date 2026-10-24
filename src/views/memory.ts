import * as coc from "coc.nvim";
import { Dashboard, registerView } from "../dashboard";
import { failed } from "../live";
import { LiveProcess } from "../sts";
import { config } from "../util";

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
export class MemoryView implements coc.TreeDataProvider<MemoryNode>, coc.Disposable {
    private readonly data: Map<string, { name: string; heap: Series; nonHeap: Series; gc: Series }> = new Map();
    private readonly emitter = new coc.Emitter<MemoryNode | undefined>();
    public readonly onDidChangeTreeData: coc.Event<MemoryNode | undefined> = this.emitter.event;
    private readonly timer: NodeJS.Timeout;

    constructor(private readonly d: Dashboard) {
        d.context.subscriptions.push(
            d.api.onDidLiveProcessMemoryMetricsUpdate(p => this.memory(p)),
            d.api.onDidLiveProcessGcPausesMetricsUpdate(p => this.gcPauses(p)),
            d.api.onDidLiveProcessDisconnect(p => { this.data.delete(p.processKey); this.emitter.fire(undefined); }),
        );
        this.timer = setInterval(() => this.poll(), config<number>("memory-view.fetch-data.delay-in-milliseconds", 5000));
    }

    public async poll(): Promise<void> {
        for (const app of this.d.live.apps.values()) {
            const processKey: string = app.process.processKey;
            await this.d.api.refreshLiveProcessMetricsData({ processKey, endpoint: "metrics", metricName: "memory" }).catch(e => failed(`refresh memory of ${processKey}`, e, undefined));
            await this.memory(app.process);
            await this.gcPauses(app.process);
        }
    }

    public getChildren(element?: MemoryNode): MemoryNode[] {
        // an app that disconnected while the tree is drawn has no entry any more, it renders nothing like an app without data
        const series = (key: string): MemoryNode[] => {
            const d = this.data.get(key);
            return d === undefined ? [] : [d.heap, d.nonHeap, d.gc].map(s => ({ kind: "series" as const, key: `${key}/${s.label}`, processKey: key, series: s }));
        };
        return element === undefined
            ? [...this.data.keys()].map(k => ({ kind: "app", key: k, processKey: k }))
            : (element.kind === "app" ? series(element.processKey) : []);
    }

    public getTreeItem(node: MemoryNode): coc.TreeItem {
        const s: Series | undefined = node.series;
        const current: string = s && s.values.length > 0 ? `${s.values[s.values.length - 1].toFixed(1)} ${s.unit}` : "-";
        const label: string = s ? `${s.label.padEnd(9)} ${sparkline(s.values.length > 0 ? s.values : [0])} ${current}${s.extra ? ` ${s.extra}` : ""}` : this.data.get(node.processKey)?.name ?? node.processKey;
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
    registerView(d, "spring.memoryView", "SPRING MEMORY", provider);
    d.context.subscriptions.push(provider, coc.commands.registerCommand("spring.dashboard.memory.poll", () => provider.poll()));
    return provider;
}
