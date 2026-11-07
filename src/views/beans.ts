import * as coc from "coc.nvim";
import { BootApp } from "../apps";
import { AppGroup, Dashboard, HintNode, NodeCache, appGroups, findInView, hintItem, groupDescription, hintOf, registerView, stateIcon } from "../dashboard";
import { LiveApp } from "../live";
import { IndexBean } from "../sts";
import { StaticBean } from "../symbols";
import { LocationEntry, openInSource, showLocationList } from "../output";

export type BeanGroup = AppGroup;

export interface BeanNode {
    kind: "bean";
    key: string;
    id: string;
    parent: BeanGroup;
    symbol?: StaticBean;
}

export type BeansElement = BeanGroup | BeanNode | HintNode;

/**
 * The beans view: the live beans of every connected app (all, or only the ones defined in the source), the static
 * beans of every app when nothing is connected.
 */
export class BeansView implements coc.TreeDataProvider<BeansElement> {
    public showDefinedOnly: boolean = false;
    private readonly cache = new NodeCache<BeansElement>();
    private readonly emitter = new coc.Emitter<BeansElement | undefined>();
    public readonly onDidChangeTreeData: coc.Event<BeansElement | undefined> = this.emitter.event;

    constructor(private readonly d: Dashboard) {
        d.live.onDidChange(() => this.refresh());
        d.symbols.onDidChange(() => this.refresh());
        d.apps.onDidChangeTreeData(() => this.refresh());
    }

    public refresh(): void {
        this.emitter.fire(undefined);
    }

    public getChildren(element?: BeansElement): BeansElement[] {
        const groups: BeansElement[] = this.groups();
        let children: BeansElement[];
        if (element === undefined) {
            children = groups.length > 0 ? groups : [hintOf(this.d, "beans", false)];
        } else {
            children = element.kind === "group" ? this.beans(element) : [];
        }
        return children;
    }

    public getParent(element: BeansElement): BeansElement | undefined {
        return element.kind === "bean" ? element.parent : undefined;
    }

    public getTreeItem(element: BeansElement): coc.TreeItem {
        if (element.kind === "hint") {
            return hintItem(element);
        }
        const item = new coc.TreeItem(element.kind === "group" ? element.label : element.id,
            element.kind === "group" ? coc.TreeItemCollapsibleState.Expanded : coc.TreeItemCollapsibleState.None);
        item.id = element.key;
        if (element.kind === "group") {
            item.icon = stateIcon(element.live !== undefined);
            item.description = groupDescription(element.live !== undefined, this.showDefinedOnly);
        } else {
            item.icon = { text: "◆", hlGroup: element.symbol ? "Function" : "Comment" };
            item.description = element.symbol ? "" : "no source";
            item.command = element.symbol ? { title: "Open", command: "spring.dashboard.bean.navigate", arguments: [element] } : undefined;
        }
        return item;
    }

    public resolveActions(_item: coc.TreeItem, element: BeansElement): coc.TreeItemAction<BeansElement>[] {
        const nav = element.kind === "bean" && element.symbol ? [{ title: "Go to definition", handler: async (e: BeansElement) => { await this.navigate(e); } }] : [];
        return element.kind === "bean" ? [
            ...nav,
            { title: "Show dependencies", handler: async (e: BeansElement) => { await this.dependencies(e); } },
            { title: "Show injected into", handler: async (e: BeansElement) => { await this.injectedInto(e); } },
            { title: "Show hierarchy", handler: async (e: BeansElement) => { await this.hierarchy(e); } },
        ] : [
            { title: "Show all", handler: () => { this.setDefinedOnly(false); } },
            { title: "Show defined", handler: () => { this.setDefinedOnly(true); } },
        ];
    }

    public setDefinedOnly(definedOnly: boolean): boolean {
        this.showDefinedOnly = definedOnly;
        this.refresh();
        return this.showDefinedOnly;
    }

    public find(id: string): BeanNode | undefined {
        return this.groups().flatMap(g => this.beans(g)).find(b => b.id === id);
    }

    public async navigate(arg?: BeansElement | string): Promise<string | undefined> {
        const bean = this.resolve(arg);
        if (bean?.symbol) {
            await openInSource(bean.symbol.location);
        }
        return bean?.symbol ? bean.id : undefined;
    }

    public async dependencies(arg?: BeansElement | string): Promise<number> {
        const bean = this.resolve(arg);
        const indexed = bean ? await this.indexBean(bean) : undefined;
        const entries: LocationEntry[] = indexed
            ? (indexed.injectionPoints ?? []).map(p => ({ location: p.location, text: `${p.name}: ${p.type}` }))
            : await this.liveEntries(bean, async (live, id) => (await this.d.live.beanDetail(live, id)).flatMap(b => b?.dependencies ?? []));
        return bean ? showLocationList(`Dependencies of ${bean.id}`, entries) : 0;
    }

    public async injectedInto(arg?: BeansElement | string): Promise<number> {
        const bean = this.resolve(arg);
        const indexed = bean ? await this.indexBean(bean) : undefined;
        const types: string[] = indexed ? [indexed.type, ...(indexed.supertypes ?? [])] : [];
        const all: IndexBean[] = indexed && bean ? await this.indexBeans(bean) : [];
        const entries: LocationEntry[] = indexed
            ? all.flatMap(b => (b.injectionPoints ?? []).filter(p => types.includes(p.type)).map(p => ({ location: p.location, text: `${b.name} <- ${p.name}` })))
            : await this.liveEntries(bean, async (live, id) => (await this.d.live.beansDependingOn(live, id)).map(b => b?.id ?? String(b)));
        return bean ? showLocationList(`${bean.id} is injected into`, entries) : 0;
    }

    public async hierarchy(arg?: BeansElement | string): Promise<number> {
        const bean = this.resolve(arg);
        const indexed = bean ? await this.indexBean(bean) : undefined;
        let types: string[];
        if (indexed) {
            types = [indexed.type, ...(indexed.supertypes ?? [])];
        } else if (bean?.parent.live) {
            types = (await this.d.live.beanDetail(bean.parent.live, bean.id)).map(b => b?.type).filter(Boolean);
        } else {
            types = [];
        }
        const entries: LocationEntry[] = types.map((t, i) => ({ location: i === 0 ? indexed?.location : undefined, text: `${"  ".repeat(i ? 1 : 0)}${t}` }));
        return bean ? showLocationList(`Hierarchy of ${bean.id}`, entries) : 0;
    }

    private groups(): BeanGroup[] {
        return appGroups<BeansElement, BeanGroup>(this.d, this.cache);
    }

    private beans(group: BeanGroup): BeanNode[] {
        const statics: StaticBean[] = group.app ? this.d.symbols.under(this.d.symbols.beans, group.app.path) : this.d.symbols.beans;
        const ids: string[] = group.live
            ? group.live.beans.filter(id => !this.showDefinedOnly || statics.some(s => s.id === id))
            : statics.map(s => s.id).sort((a, b) => a.localeCompare(b));
        return ids.map(id => this.cache.get<BeanNode>(`${group.key}/${id}`, () => ({ kind: "bean", key: `${group.key}/${id}`, id, parent: group })))
            .map(b => Object.assign(b, { symbol: statics.find(s => s.id === b.id) }));
    }

    private resolve(arg?: BeansElement | string): BeanNode | undefined {
        let resolved: BeanNode | undefined;
        if (typeof arg === "string") {
            resolved = this.find(arg);
        } else {
            resolved = arg?.kind === "bean" ? arg : undefined;
        }
        return resolved;
    }

    private appOf(bean: BeanNode): BootApp | undefined {
        return bean.parent.app ?? this.d.apps.apps.find(a => a.mainClass === bean.parent.live?.mainClass) ?? this.d.apps.apps[0];
    }

    private async indexBeans(bean: BeanNode): Promise<IndexBean[]> {
        const app = this.appOf(bean);
        const beans = app ? await this.d.api.getSpringIndex?.().beans({ projectName: app.projectName }).catch(() => []) : [];
        return beans ?? [];
    }

    private async indexBean(bean: BeanNode): Promise<IndexBean | undefined> {
        return (await this.indexBeans(bean)).find(b => b.name === bean.id);
    }

    private async liveEntries(bean: BeanNode | undefined, ids: (live: LiveApp, id: string) => Promise<string[]>): Promise<LocationEntry[]> {
        const names: string[] = bean?.parent.live ? await ids(bean.parent.live, bean.id) : [];
        return names.map(n => ({ location: this.d.symbols.beans.find(s => s.id === n)?.location, text: n }));
    }
}

export function registerBeans(d: Dashboard): BeansView {
    const provider = new BeansView(d);
    const view = registerView(d, "spring.beans", "SPRING BEANS", provider, { filter: true, component: "beans" });
    d.context.subscriptions.push(
        coc.commands.registerCommand("spring.dashboard.bean.navigate", (arg?: BeansElement | string) => provider.navigate(arg), undefined, true),
        coc.commands.registerCommand("spring.dashboard.bean.open", (arg?: BeansElement | string) => provider.navigate(arg), undefined, true),
        coc.commands.registerCommand("spring.dashboard.bean.showAll", () => provider.setDefinedOnly(false), undefined, true),
        coc.commands.registerCommand("spring.dashboard.bean.showDefined", () => provider.setDefinedOnly(true), undefined, true),
        coc.commands.registerCommand("spring.dashboard.bean.showDependencies", (arg?: BeansElement | string) => provider.dependencies(arg), undefined, true),
        coc.commands.registerCommand("spring.dashboard.bean.showInjectedInto", (arg?: BeansElement | string) => provider.injectedInto(arg), undefined, true),
        coc.commands.registerCommand("spring.dashboard.bean.showHierarchy", (arg?: BeansElement | string) => provider.hierarchy(arg), undefined, true),
        coc.commands.registerCommand("spring.beans.find", () => findInView(view), undefined, true),
    );
    return provider;
}
