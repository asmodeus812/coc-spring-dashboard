import * as coc from "coc.nvim";

/**
 * A row of a panel: the text shown and the key its pick edits.
 */
export interface Row {
    label: string;
    key: string;
}

/**
 * A row with its name in a column and the value after it.
 */
export function row(name: string, value: string, key: string): Row {
    return { label: `  ${name.padEnd(15)}${value}`, key };
}

/**
 * A panel: one quick pick with the action first and the rows below it. Picking a row edits the settings and shows the
 * panel again, picking the action returns the settings, Esc returns undefined.
 */
export async function showPanel<T>(title: string, action: string, initial: T, rows: (s: T) => Row[], edit: (s: T, key: string) => Promise<T>): Promise<T | undefined> {
    let settings: T = initial;
    let result: T | undefined = undefined;
    let done: boolean = false;
    while (!done) {
        const picked = await coc.window.showQuickPick([{ label: `▶ ${action} with these settings`, key: "go" }, ...rows(settings)], { title });
        if (picked === undefined) {
            done = true;
        } else if (picked.key === "go") {
            result = settings;
            done = true;
        } else {
            settings = await edit(settings, picked.key);
        }
    }
    return result;
}

/**
 * A list as one line of text, quoted where `splitArgs` needs it to read it back.
 */
export function joinArgs(items: string[]): string {
    return items.map(i => (/[\s"'\\]/.test(i) ? `"${i.replace(/["\\]/g, c => `\\${c}`)}"` : i)).join(" ");
}
