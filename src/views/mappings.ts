import * as coc from "coc.nvim";
import { AppGroup, Dashboard, NodeCache, appGroups, findInView, registerView, stateIcon } from "../dashboard";
import { LiveApp } from "../live";
import { StaticEndpoint, endpointLabel } from "../symbols";
import { formatUrl, jumpTo, openUrl } from "../util";

export type MappingGroup = AppGroup;

export interface MappingNode {
    kind: "mapping";
    key: string;
    label: string;
    pattern: string;
    method?: string;
    parent: MappingGroup;
    symbol?: StaticEndpoint;
}

export type MappingsElement = MappingGroup | MappingNode;

/**
 * The pattern and method of a live mapping, as the actuator reports it.
 */
function liveMapping(raw: any): { pattern: string; method?: string } {
    const map = raw?.data?.map ?? raw;
    const conditions = map?.details?.map?.requestMappingConditions?.map;
    return {
        pattern: conditions?.patterns?.myArrayList?.[0] ?? map?.predicate ?? "unknown",
        method: conditions?.methods?.myArrayList?.[0],
    };
}

/**
 * The endpoint mappings view: the live mappings of every connected app (all, or only the ones defined in the source),
 * the static mappings of every app when nothing is connected.
 */
export class MappingsView implements coc.TreeDataProvider<MappingsElement> {
    public showDefinedOnly: boolean = false;
    private readonly cache = new NodeCache<MappingsElement>();
    private readonly emitter = new coc.Emitter<MappingsElement | undefined>();
    public readonly onDidChangeTreeData: coc.Event<MappingsElement | undefined> = this.emitter.event;

    constructor(private readonly d: Dashboard) {
        d.live.onDidChange(() => this.refresh());
        d.symbols.onDidChange(() => this.refresh());
        d.apps.onDidChangeTreeData(() => this.refresh());
    }

    public refresh(): void {
        this.emitter.fire(undefined);
    }

    public getChildren(element?: MappingsElement): MappingsElement[] {
        return element === undefined ? this.groups() : (element.kind === "group" ? this.mappings(element) : []);
    }

    public getParent(element: MappingsElement): MappingsElement | undefined {
        return element.kind === "mapping" ? element.parent : undefined;
    }

    public getTreeItem(element: MappingsElement): coc.TreeItem {
        const item = new coc.TreeItem(element.label, element.kind === "group" ? coc.TreeItemCollapsibleState.Expanded : coc.TreeItemCollapsibleState.None);
        item.id = element.key;
        if (element.kind === "group") {
            item.icon = stateIcon(element.live !== undefined);
            item.description = element.live ? (this.showDefinedOnly ? "live, defined" : "live, all") : "defined";
        } else {
            item.icon = { text: "↗", hlGroup: element.symbol ? "Function" : "Comment" };
            item.description = element.symbol ? "" : "no source";
            item.command = element.symbol ? { title: "Open", command: "spring.dashboard.endpoint.navigate", arguments: [element] } : undefined;
        }
        return item;
    }

    public resolveActions(_item: coc.TreeItem, element: MappingsElement): coc.TreeItemAction<MappingsElement>[] {
        const nav = element.kind === "mapping" && element.symbol ? [{ title: "Go to definition", handler: async (e: MappingsElement) => { await this.navigate(e); } }] : [];
        const open = element.kind === "mapping" && this.liveOf(element) ? [{ title: "Open in browser", handler: async (e: MappingsElement) => { await this.open(e); } }] : [];
        return element.kind === "mapping" ? [...nav, ...open] : [
            { title: "Show all", handler: () => { this.setDefinedOnly(false); } },
            { title: "Show defined", handler: () => { this.setDefinedOnly(true); } },
        ];
    }

    public setDefinedOnly(definedOnly: boolean): boolean {
        this.showDefinedOnly = definedOnly;
        this.refresh();
        return this.showDefinedOnly;
    }

    public find(label: string): MappingNode | undefined {
        return this.groups().flatMap(g => this.mappings(g)).find(m => m.label === label || m.pattern === label);
    }

    public async navigate(arg?: MappingsElement | string): Promise<string | undefined> {
        const mapping = this.resolve(arg);
        if (mapping?.symbol) {
            await jumpTo(mapping.symbol.location);
        }
        return mapping?.symbol ? mapping.label : undefined;
    }

    public async open(arg?: MappingsElement | string): Promise<string | undefined> {
        const mapping = this.resolve(arg);
        const live = mapping ? this.liveOf(mapping) : undefined;
        if (mapping && !live) {
            coc.window.showWarningMessage(`The app of ${mapping.label} is not running`);
        }
        return mapping && live ? openUrl(formatUrl(live.port, live.contextPath, mapping.pattern)) : undefined;
    }

    private liveOf(mapping: MappingNode): LiveApp | undefined {
        return mapping.parent.live ?? (mapping.parent.app ? this.d.live.byMainClass(mapping.parent.app.mainClass) : undefined);
    }

    private groups(): MappingGroup[] {
        return appGroups<MappingsElement, MappingGroup>(this.d, this.cache);
    }

    private mappings(group: MappingGroup): MappingNode[] {
        const statics: StaticEndpoint[] = group.app ? this.d.symbols.under(this.d.symbols.mappings, group.app.path) : this.d.symbols.mappings;
        const defined = (pattern: string, method?: string) => statics.find(s => s.pattern === pattern && (!s.method || !method || s.method === method));
        const entries = group.live
            ? group.live.mappings.map(liveMapping).filter(m => !this.showDefinedOnly || defined(m.pattern, m.method))
            : statics.map(s => ({ pattern: s.pattern, method: s.method }));
        return entries
            .map(m => ({ ...m, label: endpointLabel(m.pattern, m.method) }))
            .sort((a, b) => a.label.localeCompare(b.label))
            .map(m => Object.assign(this.cache.get<MappingNode>(`${group.key}/${m.label}`, () => ({ kind: "mapping", key: `${group.key}/${m.label}`, parent: group, ...m })),
                { symbol: defined(m.pattern, m.method) }));
    }

    private resolve(arg?: MappingsElement | string): MappingNode | undefined {
        return typeof arg === "string" ? this.find(arg) : (arg?.kind === "mapping" ? arg : undefined);
    }
}

export function registerMappings(d: Dashboard): MappingsView {
    const provider = new MappingsView(d);
    const view = registerView(d, "spring.mappings", "SPRING ENDPOINT MAPPINGS", provider, true);
    d.finders.set("spring.mappings", (key: string) => provider.find(key));
    d.context.subscriptions.push(
        coc.commands.registerCommand("spring.dashboard.endpoint.navigate", (arg?: MappingsElement | string) => provider.navigate(arg)),
        coc.commands.registerCommand("spring.dashboard.endpoint.open", (arg?: MappingsElement | string) => provider.open(arg)),
        coc.commands.registerCommand("spring.dashboard.mapping.showAll", () => provider.setDefinedOnly(false)),
        coc.commands.registerCommand("spring.dashboard.mapping.showDefined", () => provider.setDefinedOnly(true)),
        coc.commands.registerCommand("spring.mappings.find", () => findInView(view)),
    );
    return provider;
}
