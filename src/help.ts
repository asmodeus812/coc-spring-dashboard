import * as coc from "coc.nvim";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Makes `:help coc-spring-dashboard` work. coc does not put an extension on the runtimepath, and putting the extension folder
 * there would make coc load the extension again, so the help page is copied to a folder of its own in the storage of
 * the extension, tagged there and that folder is added to the runtimepath.
 */
export async function registerHelp(context: coc.ExtensionContext): Promise<void> {
    const root: string = path.join(context.storagePath, "runtime");
    const doc: string = path.join(root, "doc");
    await fs.promises.mkdir(doc, { recursive: true });
    await fs.promises.copyFile(path.join(context.extensionPath, "doc", "coc-spring-dashboard.txt"), path.join(doc, "coc-spring-dashboard.txt"));
    await coc.workspace.nvim.command(`silent! helptags ${await coc.workspace.nvim.call("fnameescape", [doc])}`);
    // a single :set appends atomically; reading then writing the option would race with other extensions
    const escaped: string = root.replace(/([ ,\\])/g, String.raw`\$1`);
    await coc.workspace.nvim.command(`set runtimepath-=${escaped} runtimepath+=${escaped}`);
}
