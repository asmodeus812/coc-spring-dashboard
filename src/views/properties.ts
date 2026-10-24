import * as coc from "coc.nvim";
import { Dashboard, NodeCache, findInView, registerView } from "../dashboard";
import { LiveApp, PropertyGroup } from "../live";

export type PropertiesElement =
    | { kind: "app"; key: string; live: LiveApp }
    | { kind: "source"; key: string; group: PropertyGroup }
    | { kind: "property"; key: string; name: string; value: string };

/**
 * The properties view: the live properties of every connected app, grouped by their property source.
 */
export class PropertiesView implements coc.TreeDataProvider<PropertiesElement> {
    private readonly cache = new NodeCache<PropertiesElement>();
    private readonly emitter = new coc.Emitter<PropertiesElement | undefined>();
    public readonly onDidChangeTreeData: coc.Event<PropertiesElement | undefined> = this.emitter.event;

    constructor(private readonly d: Dashboard) {
        d.live.onDidChange(() => this.emitter.fire(undefined));
    }

    public async getChildren(element?: PropertiesElement): Promise<PropertiesElement[]> {
        let children: PropertiesElement[];
        if (element === undefined) {
            children = [...this.d.live.apps.values()].map(l => Object.assign(this.cache.get(`app:${l.process.processKey}`, () => ({ kind: "app", key: `app:${l.process.processKey}`, live: l })), { live: l }));
        } else if (element.kind === "app") {
            children = (await this.d.live.properties(element.live)).map(g => this.cache.get(`${element.key}/${g.name}`, () => ({ kind: "source", key: `${element.key}/${g.name}`, group: g })));
        } else if (element.kind === "source") {
            children = element.group.properties.map(p => ({ kind: "property", key: `${element.key}/${p.name}`, name: p.name, value: p.value }));
        } else {
            children = [];
        }
        return children;
    }

    public getTreeItem(element: PropertiesElement): coc.TreeItem {
        let label: string;
        let state: coc.TreeItemCollapsibleState;
        let icon: coc.TreeItemIcon;
        if (element.kind === "app") {
            label = element.live.process.processName;
            state = coc.TreeItemCollapsibleState.Expanded;
            icon = { text: "●", hlGroup: "DiagnosticOk" };
        } else if (element.kind === "source") {
            label = element.group.name;
            state = coc.TreeItemCollapsibleState.Collapsed;
            icon = { text: "▤", hlGroup: "Directory" };
        } else {
            label = `${element.name}: ${element.value}`;
            state = coc.TreeItemCollapsibleState.None;
            icon = { text: "·", hlGroup: "Comment" };
        }
        const item = new coc.TreeItem(label, state);
        item.id = element.key;
        item.icon = icon;
        return item;
    }
}

export function registerProperties(d: Dashboard): PropertiesView {
    const provider = new PropertiesView(d);
    const view = registerView(d, "spring.properties", "SPRING PROPERTIES", provider, true);
    d.context.subscriptions.push(coc.commands.registerCommand("spring.properties.find", () => findInView(view)));
    return provider;
}
