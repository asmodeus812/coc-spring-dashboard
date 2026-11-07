import * as coc from "coc.nvim";
import * as fs from "fs";
import * as path from "path";
import { LaunchTarget } from "./launch";
import { javaCommand } from "./util";

const RESOURCES: string = path.join("src", "main", "resources");
const CLASSPATH_ENTRIES: string = "org.eclipse.jdt.ls.core.classpathEntries";

/**
 * The source folders of a project from the jdtls classpath, with the `config` folder of each.
 */
async function sourceFolders(app: LaunchTarget): Promise<string[]> {
    const projectSettings = await javaCommand<Record<string, any[]> | undefined>("java.project.getSettings", coc.Uri.file(app.path).toString(), [CLASSPATH_ENTRIES]).catch(() => undefined);
    const entries: any[] = projectSettings?.[CLASSPATH_ENTRIES] ?? [];
    // jdtls may report the paths relative to its workspace (`/<project>/src/main/resources`): those resolve against the
    // project folder; the standard folders are always looked at, only the folders that exist are kept
    const resolved: string[] = entries
        .filter(e => e.kind === "source" || e.kind === 3 || e.entryKind === 3)
        .map(e => String(e.path))
        .map(p => (path.isAbsolute(p) && fs.existsSync(p) ? p : path.join(app.path, p.replace(new RegExp(`^/?${app.projectName}/`), ""))));
    const folders: string[] = [...resolved, path.join(app.path, RESOURCES), path.join(app.path, "src", "main", "java")];
    return [...new Set(folders)].filter(f => fs.existsSync(f));
}

/**
 * The profiles of a project, like upstream: the `(application|bootstrap)-<profile>` files of the source folders and
 * their `config` subfolders.
 */
export async function discoverProfiles(app: LaunchTarget): Promise<string[]> {
    const found: Set<string> = new Set();
    for (const folder of await sourceFolders(app)) {
        for (const dir of [folder, path.join(folder, "config")]) {
            const files: string[] = fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? fs.readdirSync(dir) : [];
            for (const file of files) {
                const named: RegExpMatchArray | null = file.match(/^(application|bootstrap)-(.*)\.(properties|yml|yaml)$/);
                if (named) {
                    found.add(named[2]);
                }
            }
        }
    }
    return [...found].sort();
}
