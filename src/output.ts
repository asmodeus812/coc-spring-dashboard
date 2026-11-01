import * as coc from "coc.nvim";
import * as path from "path";
import { config } from "./util";

/**
 * A Vimscript string literal.
 */
function vimString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The tab variables of an app tab: the key of its app, its name, the buffer of its terminal and the window it was started from.
 * An attached app tab has no terminal: it is marked and has a spare window to build the views around.
 */
const TAB_KEY: string = "spring_output";
const TAB_NAME: string = "spring_name";
const TAB_TERMINAL: string = "spring_terminal";
const TAB_ORIGIN: string = "spring_origin";
// the id of the tab of the origin window, a tab number changes when tabs move or close
const TAB_SOURCE: string = "spring_source";
const TAB_ATTACHED: string = "spring_attached";
const TAB_ANCHOR: string = "spring_anchor";

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
 * Mappings, Properties and Memory views in four equal columns, the lower half the terminal of the app; the tab closes
 * when the app stops unless `layout.cleanup` is "keep". A coc tree view lives in one window only (it keeps one buffer and one window id), so the views
 * move into the app tab that is current when it is entered, the other app tabs keep the terminal only until they are
 * entered again. Plain Ex commands and Vimscript functions, so it is the same in Vim and Neovim.
 */
export class OutputTabs {
    /** The views of the upper half, left to right. */
    private views: () => coc.TreeView<any>[] = () => [];
    /** Told the app of the tab that was entered, undefined for any other tab. */
    private onApp: (name: string | undefined) => void = () => undefined;
    // layouts are built one after the other, the tab events come while one is built
    private queue: Promise<void> = Promise.resolve();

    /**
     * The app of a tab stopped and coc wiped its terminal. With `layout.cleanup` "always" the tab closes, with "keep" it
     * stays for the next run. A tab that holds the live terminal of a new run stays, so does the last tab.
     */
    public stopped(key: string): Promise<void> {
        this.queue = this.queue.then(() => this.closeStopped(key)).catch(() => undefined);
        return this.queue;
    }

    private async closeStopped(key: string): Promise<void> {
        const nvim = coc.workspace.nvim;
        const found: number = await appTabOf(key);
        const last: number = (await nvim.call("tabpagenr", ["$"])) as number;
        const live: boolean = found > 0 && (await nvim.call("bufexists", [await tabVar(TAB_TERMINAL, 0, found)])) as number === 1;
        if (config<string>("layout.cleanup", "always") === "always" && found > 0 && last > 1 && !live) {
            await nvim.command(`tabclose ${found}`);
        }
    }

    /**
     * Shows the terminal buffer in the tab of the app and builds its layout, a tab that exists is reused and the buffer
     * of the previous run is wiped. The focus stays in the tab, in the terminal.
     */
    public async show(tab: TabApp, bufnr: number, origin: number = 0): Promise<void> {
        const nvim = coc.workspace.nvim;
        const found: number = await appTabOf(tab.key);
        // the terminal window coc opens is not needed, the buffer stays
        for (const id of (await nvim.call("win_findbuf", [bufnr])) as number[]) {
            const win: number = (await nvim.call("win_id2win", [id])) as number;
            if (win > 0 && (await nvim.call("winnr", ["$"])) as number > 1) {
                await nvim.command(`silent! ${win}close`);
            }
        }
        await this.place(tab, bufnr, found, origin);
        await this.layout(true);
    }

    /**
     * Shows the tab of an app that was not started here: the four views fill it, there is no terminal. A tab that exists is
     * reused. The focus stays in the tab.
     */
    public async showViews(tab: TabApp, origin: number = 0): Promise<void> {
        const nvim = coc.workspace.nvim;
        const found: number = await appTabOf(tab.key);
        await this.enterAppTab(tab, found);
        if (found === 0) {
            await setTabVar(TAB_ATTACHED, 1);
            await setTabVar(TAB_ANCHOR, (await nvim.call("win_getid")) as number);
            await nvim.command(`silent! execute 'tcd ' . fnameescape(${vimString(tab.folder)})`);
        }
        await this.setOrigin(origin);
        await this.layout(true);
    }

    // the tab of an app: a new one at the end with its key and name, or the one that exists
    private async enterAppTab(tab: TabApp, found: number): Promise<void> {
        if (found === 0) {
            await coc.workspace.nvim.command("$tabnew");
            await setTabVar(TAB_KEY, tab.key);
            await setTabVar(TAB_NAME, tab.name);
        } else {
            await coc.workspace.nvim.command(`tabnext ${found}`);
        }
    }

    private async setOrigin(origin: number): Promise<void> {
        if (origin > 0) {
            await setTabVar(TAB_ORIGIN, origin);
            await setTabVar(TAB_SOURCE, (await coc.workspace.nvim.createWindow(origin).tabpage).id);
        }
    }

    // the terminal buffer in the app's tab: a new tab at the end, or the one of the previous run
    private async place(tab: TabApp, bufnr: number, found: number, origin: number): Promise<void> {
        const nvim = coc.workspace.nvim;
        await this.enterAppTab(tab, found);
        if (found > 0) {
            // the window of the terminal, the one that was current may be a view; a closed one is made again
            const win: number = await this.terminalWindow();
            if (win > 0) {
                await nvim.call("win_gotoid", [win]);
            } else {
                await nvim.command("botright new");
            }
        }
        await this.setOrigin(origin);
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
     * The window a launch started from, to open sources in later: the current window, or the origin of the current tab
     * when that is an app tab itself.
     */
    public async origin(): Promise<number> {
        return (await inAppTab()) ? await tabVar(TAB_ORIGIN, 0) : (await coc.workspace.nvim.call("win_getid")) as number;
    }

    /**
     * Whether an app has a dashboard tab.
     */
    public async has(key: string): Promise<boolean> {
        return (await appTabOf(key)) > 0;
    }

    /**
     * Switches to the tab of an app and restores its layout, false when it has none.
     */
    public async focus(key: string): Promise<boolean> {
        const found: number = await appTabOf(key);
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
        context.subscriptions.push(
            coc.commands.registerCommand("spring-boot-dashboard.appTab.entered", () => this.layout(false), undefined, true),
            // a debugger stop of an app opens in its source window; nvim-dap counts from 1, an unknown column is 0
            coc.commands.registerCommand("spring-boot-dashboard.source.open", (key: string, uri: string, line: number, column: number) =>
                openInSource(coc.Location.create(uri, coc.Range.create(line - 1, Math.max(0, column - 1), line - 1, Math.max(0, column - 1))), key), undefined, true),
        );
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

    // the spare window of an attached tab: the one it was made with, a new one when that is gone
    private async spareWindow(tab: number): Promise<number> {
        const nvim = coc.workspace.nvim;
        let win: number = await tabVar(TAB_ANCHOR, 0);
        if (win === 0 || await tabOf(win) !== tab) {
            await nvim.command("botright new");
            win = (await nvim.call("win_getid")) as number;
            await setTabVar(TAB_ANCHOR, win);
        }
        return win;
    }

    private layout(reset: boolean): Promise<void> {
        this.queue = this.queue.then(() => this.build(reset)).catch(() => undefined);
        return this.queue;
    }

    /**
     * Makes the layout of the current tab when it is an app tab: the views over the terminal. Views that sit in another
     * tab move here. A missing view makes all four again, in their order, `wincmd =` gives the columns the same width
     * and the terminal gets `layout.terminalHeight` percent of the height.
     */
    private async build(reset: boolean): Promise<void> {
        const nvim = coc.workspace.nvim;
        const name: string = await tabVar(TAB_NAME, "");
        const tab: number = (await nvim.call("tabpagenr")) as number;
        const views: coc.TreeView<any>[] = this.views();
        const window: number = name === "" ? 0 : await this.terminalWindow();
        // a tab of an attached app has no terminal, the views fill it; so they do when `layout.components` has no terminal
        const attached: boolean = name !== "" && ((await tabVar(TAB_ATTACHED, 0)) === 1 || !inLayout("terminal"));
        const terminal: number = attached ? 0 : window;
        const before: number = (await nvim.call("win_getid")) as number;
        this.onApp(name === "" ? undefined : name);
        if ((terminal > 0 || attached) && views.length > 0) {
            const complete: boolean = await this.viewsComplete(views, tab);
            let spare: number = terminal;
            if (!complete) {
                // an attached tab builds around a spare window, the terminal window when it is there
                if (attached) {
                    spare = window > 0 ? window : await this.spareWindow(tab);
                }
                await this.rebuildViews(views, spare, attached ? "aboveleft vs" : "aboveleft split");
            }
            // the spare window goes once the views are in, so does a terminal that `layout.components` leaves out (it
            // keeps running without a window)
            if (attached) {
                for (const win of [spare, window].filter(w => w > 0)) {
                    await nvim.call("win_execute", [win, "silent! noautocmd close"]);
                }
            }
            if (!complete || reset) {
                await nvim.command("wincmd =");
                if (!attached) {
                    await sizeTerminal(terminal, views[0].windowId ?? 0);
                }
            }
            // only a rebuilt layout moved the focus: back to the window the user was in (the terminal when it is gone);
            // a complete layout leaves the focus alone, the user may already be in another window of the tab
            if (!complete) {
                const stay: boolean = await tabOf(before) === tab;
                await nvim.call("win_gotoid", [stay ? before : (attached ? views[0].windowId : terminal)]);
            }
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
    private async rebuildViews(views: coc.TreeView<any>[], anchor: number, split: string): Promise<void> {
        const nvim = coc.workspace.nvim;
        for (const view of views) {
            if (view.visible && view.windowId !== undefined) {
                await nvim.call("win_execute", [view.windowId, "silent! noautocmd close"]);
            }
        }
        await nvim.call("win_gotoid", [anchor]);
        await views[0].show(split);
        for (let i = 1; i < views.length; i++) {
            await nvim.call("win_gotoid", [views[i - 1].windowId]);
            await views[i].show("belowright vs");
        }
    }
}

/**
 * Gives the terminal under the views `spring.dashboard.layout.terminalHeight` percent (10 to 90) of the height the two
 * share, the status line between them included.
 */
async function sizeTerminal(terminal: number, view: number): Promise<void> {
    const nvim = coc.workspace.nvim;
    const percent: number = Math.min(90, Math.max(10, config<number>("layout.terminalHeight", 65)));
    const shared: number = (await nvim.call("winheight", [terminal])) as number + ((await nvim.call("winheight", [view])) as number) + 1;
    await nvim.call("win_execute", [terminal, `resize ${Math.round(shared * percent / 100)}`]);
}

const COMPONENTS: string[] = ["beans", "endpoints", "properties", "memory", "terminal"];

/**
 * Whether `layout.components` lists a component of the app tab; unknown names are left out, an empty list is all.
 */
export function inLayout(component: string): boolean {
    const listed: string[] = config<string[]>("layout.components", COMPONENTS).filter(c => COMPONENTS.includes(c));
    return (listed.length > 0 ? listed : COMPONENTS).includes(component);
}

/**
 * Whether the current tab is an app tab.
 */
async function inAppTab(): Promise<boolean> {
    return (await tabVar(TAB_KEY, "")) !== "";
}

/**
 * Whether a source can open in a window: a file window (empty buftype, so no terminal, tree or list), not a float or a
 * popup, not fixed to its buffer (`winfixbuf`, which Vim does not have and reads as 0).
 */
async function suitable(win: number): Promise<boolean> {
    const nvim = coc.workspace.nvim;
    const bufnr: number = (await nvim.call("winbufnr", [win])) as number;
    const buftype: string = bufnr > 0 ? (await nvim.call("getbufvar", [bufnr, "&buftype"])) as string : "none";
    // getwinvar() does not read the options of a window in another tab, gettabwinvar() does
    const [tab, nr] = (await nvim.call("win_id2tabwin", [win])) as number[];
    const fixed: number = (await nvim.call("gettabwinvar", [tab, nr, "&winfixbuf", 0])) as number;
    const type: string = (await nvim.call("win_gettype", [win])) as string;
    return buftype === "" && fixed !== 1 && type === "";
}

/**
 * The windows of a tab a source can open in.
 */
async function suitableWindowsOf(tab: number): Promise<number[]> {
    const windows = (await coc.workspace.nvim.call("gettabinfo", [tab])) as { windows: number[] }[];
    const found: number[] = [];
    for (const win of windows[0]?.windows ?? []) {
        if (await suitable(win)) {
            found.push(win);
        }
    }
    return found;
}

/**
 * The number of the tab with an id, 0 when it is closed.
 */
async function tabNrOf(id: number): Promise<number> {
    const tab: coc.Tabpage | undefined = (await coc.workspace.nvim.tabpages).find(t => t.id === id);
    return tab === undefined ? 0 : await tab.number;
}

/**
 * The number of the dashboard tab of an app, 0 when there is none.
 */
async function appTabOf(key: string): Promise<number> {
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
 * The source window of an app: the window its run, debug or attach was started from while it shows a file, otherwise
 * the first window of that window's tab that does. Undefined when there is none, or the app has no dashboard tab.
 */
export async function sourceWindowOf(key: string): Promise<number | undefined> {
    const tab: number = await appTabOf(key);
    const origin: number = tab > 0 ? await tabVar(TAB_ORIGIN, 0, tab) : 0;
    let win: number | undefined = origin;
    if (!(origin > 0 && await tabOf(origin) > 0 && await suitable(origin))) {
        const source: number = tab > 0 ? await tabVar(TAB_SOURCE, 0, tab) : 0;
        const sourceTab: number = source > 0 ? await tabNrOf(source) : 0;
        win = sourceTab > 0 ? (await suitableWindowsOf(sourceTab))[0] : undefined;
    }
    return win;
}

/**
 * Opens a float over the current tab when no window can take a source: centered, `layout.fallbackSize` percent of the screen,
 * with the file of `location` at its line, or `lines` in a scratch buffer. coc's float helper takes the file's own
 * buffer, so in Neovim the float is a window to work in and is returned; a Vim popup cannot be entered, it only shows
 * the target, and undefined is returned.
 */
async function openFloat(location: coc.Location | undefined, lines: string[]): Promise<number | undefined> {
    const nvim = coc.workspace.nvim;
    const percent: number = Math.min(100, Math.max(20, config<number>("layout.fallbackSize", 75)));
    const columns: number = coc.workspace.env.columns;
    // without the tabline and the command line
    const height: number = coc.workspace.env.lines - coc.workspace.env.cmdheight - 1;
    const size = { width: Math.floor(columns * percent / 100), height: Math.floor(height * percent / 100) };
    const bufnr: number = location ? (await coc.workspace.loadFile(location.uri)).bufnr : 0;
    const title: string = location ? path.basename(coc.Uri.parse(location.uri).fsPath) : lines[0] ?? "";
    const [winid] = (await nvim.call("coc#float#create_float_win", [0, bufnr, {
        relative: "editor", row: Math.floor((height - size.height) / 2), col: Math.floor((columns - size.width) / 2), ...size,
        border: [1, 1, 1, 1], rounded: 1, focusable: true, title, lines: location ? null : lines,
    }])) as number[];
    const line: number = location ? location.range.start.line + 1 : 1;
    await nvim.call("win_execute", [winid, `if &filetype ==# '' | filetype detect | endif | call cursor(${line}, 1) | normal! zz`]);
    let entered: number | undefined = undefined;
    if (coc.workspace.isNvim) {
        await nvim.call("win_gotoid", [winid]);
        entered = winid;
    } else {
        // a cursor move closes the popup
        await nvim.call("popup_setoptions", [winid, { moved: "any" }]);
    }
    return entered;
}

export interface LocationEntry {
    location?: coc.Location;
    text: string;
}

/**
 * Shows the entries in the location list of the source window, entries without a location are plain text lines.
 */
export async function showLocationList(title: string, entries: LocationEntry[]): Promise<number> {
    const nvim = coc.workspace.nvim;
    const items = entries.map(e => e.location
        ? { filename: coc.Uri.parse(e.location.uri).fsPath, lnum: e.location.range.start.line + 1, col: e.location.range.start.character + 1, text: e.text }
        : { text: e.text });
    const win: number | undefined = await focusSource(entries.find(e => e.location)?.location, [title, ...entries.map(e => e.text)]);
    if (win !== undefined) {
        await nvim.call("setloclist", [win, [], " ", { title, items }]);
        await nvim.command("botright lopen");
    }
    return items.length;
}

/**
 * Opens a location in the source window of the app `key` (the app of the current tab when not given), or in the float.
 */
export async function openInSource(location: coc.Location, key?: string): Promise<void> {
    if (await focusSource(location, [], key) !== undefined) {
        await coc.workspace.jumpTo(location.uri, location.range.start);
    }
}

/**
 * Goes to the source window of the app `key` (the app of the current tab when not given), or opens the float with
 * `location` (or `lines`) when it has none. Returns the window, undefined when only a Vim popup shows the target.
 */
async function focusSource(location: coc.Location | undefined, lines: string[], key?: string): Promise<number | undefined> {
    const app: string = key ?? await tabVar(TAB_KEY, "");
    let win: number | undefined = app !== "" ? await sourceWindowOf(app) : undefined;
    if (win === undefined) {
        win = await openFloat(location, lines);
    } else {
        await coc.workspace.nvim.call("win_gotoid", [win]);
    }
    return win;
}
