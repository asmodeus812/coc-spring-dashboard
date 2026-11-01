import * as coc from "coc.nvim";
import { AppsView, BootApp } from "./apps";
import { AppState } from "./launch";
import { LiveApp, LiveData } from "./live";
import { inLayout, releaseView } from "./output";
import { StsApi } from "./sts";
import { Symbols } from "./symbols";
import { need, ready } from "./ready";

/**
 * Everything the views and features share.
 */
export interface Dashboard {
    context: coc.ExtensionContext;
    api: StsApi;
    live: LiveData;
    symbols: Symbols;
    apps: AppsView;
    /** The app whose tab is current, the empty views name it in their hint. */
    appTab: AppTab;
    views: Map<string, coc.TreeView<any>>;
}

/**
 * The app of the app tab that is current, none in any other tab.
 */
export class AppTab {
    public name: string | undefined;
    private readonly emitter = new coc.Emitter<void>();
    public readonly onDidChange: coc.Event<void> = this.emitter.event;

    /** Tells the views to draw their hints again. */
    public refresh(): void {
        this.emitter.fire();
    }

    public set(name: string | undefined): void {
        if (name !== this.name) {
            this.name = name;
            this.emitter.fire();
        }
    }
}

/**
 * The one row of a view that has nothing to show, it says what to do.
 */
export interface HintNode {
    kind: "hint";
    key: string;
    label: string;
}

/**
 * The hint of a view with no data, `what` is the plural of what it lists. Live views name the app of the current tab.
 */
export function hintOf(d: Dashboard, what: string, live: boolean): HintNode {
    const app: string | undefined = d.appTab.name;
    let label: string;
    if (!ready("spring")) {
        label = "Spring Boot server not running";
    } else if (!live) {
        label = `No ${what} yet`;
    } else if (app === undefined) {
        label = `Run an app to see its ${what}`;
    } else if (d.apps.isStarted(app)) {
        label = `${app} is not connected yet`;
    } else {
        label = `Run ${app} to see its ${what}`;
    }
    return { kind: "hint", key: "hint", label };
}

export function hintItem(hint: HintNode): coc.TreeItem {
    const item = new coc.TreeItem(hint.label, coc.TreeItemCollapsibleState.None);
    item.id = hint.key;
    item.icon = { text: "·", hlGroup: "Comment" };
    return item;
}

/** The `layout.components` name of a view of the app tab. */
const components: WeakMap<coc.TreeView<any>, string> = new WeakMap();

/**
 * Creates a tree view. A view of the app tab names its `component`, it is reached through that tab only.
 */
export function registerView<T>(d: Dashboard, id: string, title: string, provider: coc.TreeDataProvider<T>, { filter = false, component }: { filter?: boolean; component?: string } = {}): coc.TreeView<T> {
    const view = coc.window.createTreeView<T>(title, { treeDataProvider: provider, bufhidden: "hide", enableFilter: filter });
    keepAcrossTabs(view);
    if (component !== undefined) {
        components.set(view, component);
    }
    d.views.set(id, view);
    d.context.subscriptions.push(view);
    return view;
}

/**
 * A coc TreeView remembers the tab it was last shown from (private `_targetTabId`, set in `show()`, coc.nvim
 * src/tree/TreeView.ts) and disposes itself for good when that tab closes; nothing else reads it for these views
 * (coc's outline reads the getter of its own views only). The views move between app tabs and outlive them, closed
 * by the dashboard or by hand, so the field stays unset. A coc without the field leaves the view as it is.
 */
function keepAcrossTabs(view: coc.TreeView<any>): void {
    if ("_targetTabId" in view) {
        Object.defineProperty(view, "_targetTabId", { get: () => undefined, set: () => undefined, configurable: true });
    }
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

/**
 * Opens a view. A tree view lives in one window only, one that sits in an app tab is moved into the current tab, which
 * is not an app tab.
 */
export async function focusView(view: coc.TreeView<any>): Promise<boolean> {
    const component: string | undefined = components.get(view);
    const shown: boolean = component === undefined || inLayout(component);
    if (shown) {
        await releaseView(view);
        if (!view.visible) {
            await view.show(TREE_SPLIT);
        }
    } else {
        coc.window.showWarningMessage(`${component} is not in spring.dashboard.layout.components`);
    }
    return shown;
}

/**
 * The views of the app tab that `layout.components` lists, in their fixed order.
 */
export function layoutViews(d: Dashboard): coc.TreeView<any>[] {
    return [...d.views.values()].filter(v => inLayout(components.get(v) ?? ""));
}

/**
 * Starts the filter of a view, the find commands of upstream.
 */
export async function findInView(view: coc.TreeView<any>): Promise<void> {
    if (need("spring") && await focusView(view)) {
        const key: string = coc.workspace.getConfiguration("tree").get<string>("key.activeFilter", "f");
        await coc.workspace.nvim.call("win_gotoid", [view.windowId]);
        await coc.workspace.nvim.call("feedkeys", [key, "m"]);
    }
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
