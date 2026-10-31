import * as coc from "coc.nvim";
import { AppsView, BootApp } from "./apps";
import { AppState } from "./launch";
import { LiveApp, LiveData } from "./live";
import { StsApi } from "./sts";
import { Symbols } from "./symbols";

/**
 * Everything the views and features share.
 */
export interface Dashboard {
    context: coc.ExtensionContext;
    api: StsApi;
    live: LiveData;
    symbols: Symbols;
    apps: AppsView;
    views: Map<string, coc.TreeView<any>>;
    /** Finds the element of a key in a view, used to reveal the bean or endpoint under the cursor. */
    finders: Map<string, (key: string) => unknown>;
}

/**
 * Creates a tree view and its `<id>.focus` command, which opens the view.
 */
export function registerView<T>(d: Dashboard, id: string, title: string, provider: coc.TreeDataProvider<T>, enableFilter: boolean = false): coc.TreeView<T> {
    const view = coc.window.createTreeView<T>(title, { treeDataProvider: provider, bufhidden: "hide", enableFilter });
    d.views.set(id, view);
    d.context.subscriptions.push(view, coc.commands.registerCommand(`${id}.focus`, () => focusView(view)));
    return view;
}

/**
 * How a tree view opens: a vertical split on the right.
 */
export const TREE_SPLIT: string = "botright 40vs";

/**
 * The icon of an app or a group, filled when the app is running. An app the dashboard started has more states.
 */
export function stateIcon(state: boolean | AppState): coc.TreeItemIcon {
    let icon: coc.TreeItemIcon;
    if (state === "starting" || state === "waiting") {
        icon = { text: "◐", hlGroup: "DiagnosticWarn" };
    } else if (state === "debugging") {
        icon = { text: "◉", hlGroup: "DiagnosticInfo" };
    } else if (state === true || state === "running") {
        icon = { text: "●", hlGroup: "DiagnosticOk" };
    } else {
        icon = { text: "○", hlGroup: "Comment" };
    }
    return icon;
}

export async function focusView(view: coc.TreeView<any>): Promise<void> {
    if (!view.visible) {
        await view.show(TREE_SPLIT);
    }
}

/**
 * Starts the filter of a view, the find commands of upstream.
 */
export async function findInView(view: coc.TreeView<any>): Promise<void> {
    await focusView(view);
    const key: string = coc.workspace.getConfiguration("tree").get<string>("key.activeFilter", "f");
    await coc.workspace.nvim.call("win_gotoid", [view.windowId]);
    await coc.workspace.nvim.call("feedkeys", [key, "m"]);
}

/**
 * Keeps one element object per key, so that refreshes and reveals find the same node again.
 */
export class NodeCache<T> {
    private readonly nodes: Map<string, T> = new Map();

    public get<N extends T>(key: string, make: () => N): N {
        const node: N = (this.nodes.get(key) as N | undefined) ?? make();
        this.nodes.set(key, node);
        return node;
    }
}

/**
 * The group of a tree of beans or mappings: one per live app, or one per app of the workspace while none is live.
 */
export interface AppGroup {
    kind: "group";
    key: string;
    label: string;
    app?: BootApp;
    live?: LiveApp;
}

export function appGroups<E, G extends E & AppGroup>(d: Dashboard, cache: NodeCache<E>): G[] {
    const lives: LiveApp[] = [...d.live.apps.values()];
    return lives.length > 0
        ? lives.map(l => Object.assign(cache.get<G>(`live:${l.process.processKey}`, () => ({ kind: "group", key: `live:${l.process.processKey}`, label: l.process.processName }) as G), { live: l }))
        : d.apps.apps.map(a => cache.get<G>(`app:${a.mainClass}`, () => ({ kind: "group", key: `app:${a.mainClass}`, label: a.name, app: a }) as G));
}
