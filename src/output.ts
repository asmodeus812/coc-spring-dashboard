import * as coc from "coc.nvim";

/**
 * A Vimscript string literal.
 */
function vimString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The tab variable that holds the key of the app a tab belongs to.
 */
const TAB_KEY: string = "spring_output";

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
async function setTabVar(name: string, value: string): Promise<void> {
    const nvim = coc.workspace.nvim;
    await nvim.call("settabvar", [await nvim.call("tabpagenr"), name, value]);
}

/**
 * The output tabs: one tab per app at the end of the tab line, showing the terminal buffer of its last run. Plain Ex
 * commands and Vimscript functions, so it is the same in Vim and Neovim.
 */
export class OutputTabs {
    /**
     * The tab number of the output of an app, 0 when there is none.
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
     * Shows the terminal buffer in the tab of the app, a tab that exists is reused and the buffer of the previous run
     * is wiped. The focus returns to the tab it was in unless `focus` is set.
     */
    public async show(key: string, folder: string, bufnr: number, focus: boolean): Promise<void> {
        const nvim = coc.workspace.nvim;
        const previous: number = (await nvim.call("tabpagenr")) as number;
        const found: number = await this.find(key);
        // the terminal window coc opens is not needed, the buffer stays
        for (const id of (await nvim.call("win_findbuf", [bufnr])) as number[]) {
            const win: number = (await nvim.call("win_id2win", [id])) as number;
            if (win > 0 && (await nvim.call("winnr", ["$"])) as number > 1) {
                await nvim.command(`silent! ${win}close`);
            }
        }
        try {
            await this.place(key, folder, bufnr, found);
        } finally {
            if (!focus) {
                await nvim.command(`tabnext ${previous}`);
            }
        }
    }

    // the terminal buffer in the app's tab: a new tab at the end, or the one of the previous run
    private async place(key: string, folder: string, bufnr: number, found: number): Promise<void> {
        const nvim = coc.workspace.nvim;
        if (found === 0) {
            await nvim.command("$tabnew");
            await setTabVar(TAB_KEY, key);
        } else {
            await nvim.command(`tabnext ${found}`);
        }
        const old: number = (await nvim.call("bufnr", ["%"])) as number;
        await nvim.command(`silent! buffer ${bufnr}`);
        await nvim.call("setbufvar", [bufnr, "&bufhidden", "hide"]);
        await nvim.call("setbufvar", [bufnr, "&buflisted", 0]);
        if (old !== bufnr) {
            await nvim.command(`silent! bwipeout! ${old}`);
        }
        await nvim.command(`silent! execute 'tcd ' . fnameescape(${vimString(folder)})`);
        // the cursor on the last line keeps the terminal following the output; `normal!` is refused in terminal mode
        await nvim.call("cursor", [(await nvim.call("line", ["$"])) as number, 1]);
    }

    /**
     * Whether an app has an output tab.
     */
    public async has(key: string): Promise<boolean> {
        return (await this.find(key)) > 0;
    }

    /**
     * Switches to the output tab of an app, false when it has none.
     */
    public async focus(key: string): Promise<boolean> {
        const found: number = await this.find(key);
        if (found > 0) {
            await coc.workspace.nvim.command(`tabnext ${found}`);
        }
        return found > 0;
    }
}
