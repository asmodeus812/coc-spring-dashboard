import * as coc from "coc.nvim";

/**
 * A Vimscript string literal.
 */
function vimString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The tab variables of an app tab: the key of its app, its name, and the buffer of its terminal.
 */
const TAB_KEY: string = "spring_output";
const TAB_NAME: string = "spring_name";
const TAB_TERMINAL: string = "spring_terminal";

/**
 * A variable of a tab, the current tab when `tab` is 0.
 */
async function tabVar<T>(name: string, fallback: T, tab: number = 0): Promise<T> {
    const nvim = coc.workspace.nvim;
    return (await nvim.call("gettabvar", [tab || await nvim.call("tabpagenr"), name, fallback])) as T;
}

/**
 * Sets a variable of the current tab.
 */
async function setTabVar(name: string, value: string | number): Promise<void> {
    const nvim = coc.workspace.nvim;
    await nvim.call("settabvar", [await nvim.call("tabpagenr"), name, value]);
}

/**
 * The tab number of a window, 0 when it is gone.
 */
export async function tabOf(windowId: number): Promise<number> {
    const found = (await coc.workspace.nvim.call("win_id2tabwin", [windowId])) as number[];
    return found[0];
}

/**
 * The app an app tab shows: the key of its tab, its name and the folder of its project.
 */
export interface TabApp {
    key: string;
    name: string;
    folder: string;
}

/**
 * Closes a view that sits in an app tab other than the current one, a tree view lives in one window only.
 */
export async function releaseView(view: coc.TreeView<any>): Promise<void> {
    const nvim = coc.workspace.nvim;
    if (view.visible && view.windowId !== undefined) {
        const tab: number = await tabOf(view.windowId);
        const current: number = (await nvim.call("tabpagenr")) as number;
        if (tab > 0 && tab !== current && (await tabVar(TAB_KEY, "", tab)) !== "") {
            await nvim.call("win_execute", [view.windowId, "silent! noautocmd close"]);
        }
    }
}

/**
 * The app tabs: one tab per app at the end of the tab line, the dashboard of the app. The upper half has the Beans,
 * Mappings, Properties and Memory views in four equal columns, the lower half the terminal buffer of its last run. A
 * coc tree view lives in one window only (it keeps one buffer and one window id), so the views move into the app tab
 * that is current when it is entered, the other app tabs keep the terminal only until they are entered again. Plain Ex
 * commands and Vimscript functions, so it is the same in Vim and Neovim.
 */
export class OutputTabs {
    /** The views of the upper half, left to right. */
    private views: () => coc.TreeView<any>[] = () => [];
    /** Told the app of the tab that was entered, undefined for any other tab. */
    private onApp: (name: string | undefined) => void = () => undefined;
    // layouts are built one after the other, the tab events come while one is built
    private queue: Promise<void> = Promise.resolve();

    /**
     * The tab number of the dashboard of an app, 0 when there is none.
     */
    private async find(key: string): Promise<number> {
        const last: number = (await coc.workspace.nvim.call("tabpagenr", ["$"])) as number;
        let found: number = 0;
        for (let tab = 1; tab <= last && found === 0; tab++) {
            if ((await tabVar(TAB_KEY, "", tab)) === key) {
                found = tab;
            }
        }
        return found;
    }

    /**
     * Shows the terminal buffer in the tab of the app and builds its layout, a tab that exists is reused and the buffer
     * of the previous run is wiped. The focus returns to the tab it was in unless `focus` is set.
     */
    public async show(tab: TabApp, bufnr: number, { focus }: { focus: boolean }): Promise<void> {
        const nvim = coc.workspace.nvim;
        const previous: number = (await nvim.call("tabpagenr")) as number;
        const found: number = await this.find(tab.key);
        // the terminal window coc opens is not needed, the buffer stays
        for (const id of (await nvim.call("win_findbuf", [bufnr])) as number[]) {
            const win: number = (await nvim.call("win_id2win", [id])) as number;
            if (win > 0 && (await nvim.call("winnr", ["$"])) as number > 1) {
                await nvim.command(`silent! ${win}close`);
            }
        }
        try {
            await this.place(tab, bufnr, found);
            await this.layout(true);
        } finally {
            if (!focus) {
                await nvim.command(`tabnext ${previous}`);
            }
        }
    }

    // the terminal buffer in the app's tab: a new tab at the end, or the one of the previous run
    private async place(tab: TabApp, bufnr: number, found: number): Promise<void> {
        const nvim = coc.workspace.nvim;
        if (found === 0) {
            await nvim.command("$tabnew");
            await setTabVar(TAB_KEY, tab.key);
            await setTabVar(TAB_NAME, tab.name);
        } else {
            await nvim.command(`tabnext ${found}`);
            // the window of the terminal, the one that was current may be a view; a closed one is made again
            const win: number = await this.terminalWindow();
            if (win > 0) {
                await nvim.call("win_gotoid", [win]);
            } else {
                await nvim.command("botright new");
            }
        }
        const old: number = (await nvim.call("bufnr", ["%"])) as number;
        const previous: number = await tabVar(TAB_TERMINAL, 0);
        await nvim.command(`silent! buffer ${bufnr}`);
        await nvim.call("setbufvar", [bufnr, "&bufhidden", "hide"]);
        await nvim.call("setbufvar", [bufnr, "&buflisted", 0]);
        if (old !== bufnr) {
            await nvim.command(`silent! bwipeout! ${old}`);
        }
        if (previous > 0 && previous !== bufnr && previous !== old) {
            await nvim.command(`silent! bwipeout! ${previous}`);
        }
        await setTabVar(TAB_TERMINAL, bufnr);
        await nvim.command(`silent! execute 'tcd ' . fnameescape(${vimString(tab.folder)})`);
        // the cursor on the last line keeps the terminal following the output; `normal!` is refused in terminal mode
        await nvim.call("cursor", [(await nvim.call("line", ["$"])) as number, 1]);
    }

    /**
     * Whether an app has a dashboard tab.
     */
    public async has(key: string): Promise<boolean> {
        return (await this.find(key)) > 0;
    }

    /**
     * Switches to the tab of an app and restores its layout, false when it has none.
     */
    public async focus(key: string): Promise<boolean> {
        const found: number = await this.find(key);
        if (found > 0) {
            await coc.workspace.nvim.command(`tabnext ${found}`);
            await this.layout(true);
        }
        return found > 0;
    }

    /**
     * Puts the views in the upper half of the app tabs and restores the layout of an app tab whenever it is entered, the
     * sizes stay as they are unless a pane had to be made again.
     */
    public async useViews(context: coc.ExtensionContext, views: () => coc.TreeView<any>[], onApp: (name: string | undefined) => void): Promise<void> {
        this.views = views;
        this.onApp = onApp;
        context.subscriptions.push(coc.commands.registerCommand("spring-boot-dashboard.appTab.entered", () => this.layout(false), undefined, true));
        await coc.workspace.nvim.command(`augroup SpringDashboardTabs | autocmd! | autocmd TabEnter * if exists('t:${TAB_KEY}') | call CocActionAsync('runCommand', 'spring-boot-dashboard.appTab.entered') | endif | augroup END`);
    }

    // the window of the terminal buffer of the current tab, 0 when there is none
    private async terminalWindow(): Promise<number> {
        const nvim = coc.workspace.nvim;
        const bufnr: number = await tabVar(TAB_TERMINAL, 0);
        const tab: number = (await nvim.call("tabpagenr")) as number;
        let found: number = 0;
        for (const id of bufnr > 0 ? (await nvim.call("win_findbuf", [bufnr])) as number[] : []) {
            if (found === 0 && await tabOf(id) === tab) {
                found = id;
            }
        }
        return found;
    }

    private layout(reset: boolean): Promise<void> {
        this.queue = this.queue.then(() => this.build(reset)).catch(() => undefined);
        return this.queue;
    }

    /**
     * Makes the layout of the current tab when it is an app tab: the views over the terminal. Views that sit in another
     * tab move here. A missing view makes all four again, in their order, and `wincmd =` gives the columns and the two
     * halves the same size.
     */
    private async build(reset: boolean): Promise<void> {
        const nvim = coc.workspace.nvim;
        const name: string = await tabVar(TAB_NAME, "");
        const tab: number = (await nvim.call("tabpagenr")) as number;
        const views: coc.TreeView<any>[] = this.views();
        const terminal: number = name === "" ? 0 : await this.terminalWindow();
        this.onApp(name === "" ? undefined : name);
        if (terminal > 0 && views.length > 0) {
            const complete: boolean = await this.viewsComplete(views, tab);
            if (!complete) {
                await this.rebuildViews(views, terminal);
            }
            if (!complete || reset) {
                await nvim.command("wincmd =");
            }
            await nvim.call("win_gotoid", [terminal]);
        }
    }

    private async viewsComplete(views: coc.TreeView<any>[], tab: number): Promise<boolean> {
        const here = async (view: coc.TreeView<any>): Promise<boolean> =>
            view.visible && view.windowId !== undefined && await tabOf(view.windowId) === tab;
        let complete: boolean = true;
        for (const view of views) {
            complete = complete && await here(view);
        }
        return complete;
    }

    // a view in any tab goes, the tree view shows in one window only
    private async rebuildViews(views: coc.TreeView<any>[], terminal: number): Promise<void> {
        const nvim = coc.workspace.nvim;
        for (const view of views) {
            if (view.visible && view.windowId !== undefined) {
                await nvim.call("win_execute", [view.windowId, "silent! noautocmd close"]);
            }
        }
        await nvim.call("win_gotoid", [terminal]);
        await views[0].show("aboveleft split");
        for (let i = 1; i < views.length; i++) {
            await nvim.call("win_gotoid", [views[i - 1].windowId]);
            await views[i].show("belowright vs");
        }
    }
}
