import * as coc from "coc.nvim";
import * as fs from "fs";
import * as path from "path";

export function config<T>(key: string, fallback: T): T {
    return coc.workspace.getConfiguration("spring.dashboard").get<T>(key, fallback);
}

export async function sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fills the url template of `spring.dashboard.openUrl`.
 */
export function formatUrl(port: number | undefined, contextPath: string | undefined, suffix: string = ""): string {
    const template: string = config<string>("openUrl", "{protocol}://{hostname}:{port}{contextPath}");
    const base: string = template
        .replace("{protocol}", "http")
        .replace("{hostname}", "localhost")
        .replace("{port}", String(port ?? 8080))
        .replace("{contextPath}", contextPath ?? "");
    return base.replace(/\/$/, "") + suffix;
}

export async function openUrl(url: string): Promise<string> {
    await coc.workspace.nvim.call("coc#ui#open_url", [url]);
    return url;
}

export async function jumpTo(location: coc.Location): Promise<void> {
    await coc.workspace.nvim.command("wincmd p");
    await coc.workspace.jumpTo(location.uri, location.range.start);
}

export interface LocationEntry {
    location?: coc.Location;
    text: string;
}

/**
 * Shows the entries in the location list of the previous window, entries without a location are plain text lines.
 */
export async function showLocationList(title: string, entries: LocationEntry[]): Promise<number> {
    const nvim = coc.workspace.nvim;
    const items = entries.map(e => e.location
        ? { filename: coc.Uri.parse(e.location.uri).fsPath, lnum: e.location.range.start.line + 1, col: e.location.range.start.character + 1, text: e.text }
        : { text: e.text });
    const win: number = (await nvim.call("win_getid", [await nvim.call("winnr", ["#"])])) as number;
    await nvim.call("setloclist", [win || 0, [], " ", { title, items }]);
    await nvim.call("win_gotoid", [win]);
    await nvim.command("botright lopen");
    return items.length;
}

/**
 * The project folder of a source file: the nearest folder with a build file.
 */
export function projectRoot(file: string): string {
    let dir: string = path.dirname(file);
    while (dir !== path.dirname(dir) && !["pom.xml", "build.gradle", "build.gradle.kts"].some(f => fs.existsSync(path.join(dir, f)))) {
        dir = path.dirname(dir);
    }
    return dir;
}
