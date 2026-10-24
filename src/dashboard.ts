import * as coc from "coc.nvim";
import { AppsView } from "./apps";
import { LiveData } from "./live";
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
 * The icon of an app or a group, filled when the app is running.
 */
export function stateIcon(running: boolean): coc.TreeItemIcon {
    return running ? { text: "●", hlGroup: "DiagnosticOk" } : { text: "○", hlGroup: "Comment" };
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

    public get(key: string, make: () => T): T {
        const node: T = this.nodes.get(key) ?? make();
        this.nodes.set(key, node);
        return node;
    }
}
