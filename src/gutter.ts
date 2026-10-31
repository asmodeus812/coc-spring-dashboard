import * as coc from "coc.nvim";
import { Dashboard, focusView } from "./dashboard";
import { need } from "./ready";
import { Symbols } from "./symbols";
import { config } from "./util";

const GROUP: string = "SpringDashboard";

/**
 * Signs on the bean definitions and request mappings of a buffer, from the static symbols, behind
 * `spring.dashboard.enableGutter`.
 */
export class Gutter {
    constructor(private readonly symbols: Symbols) { }

    public async define(): Promise<void> {
        await coc.workspace.nvim.call("sign_define", [[
            { name: "SpringBean", text: "◆", texthl: "DiagnosticInfo" },
            { name: "SpringMapping", text: "↗", texthl: "DiagnosticHint" },
        ]]);
    }

    public async place(bufnr: number): Promise<number> {
        const doc = coc.workspace.getDocument(bufnr);
        const enabled: boolean = config<string>("enableGutter", "on") === "on";
        const at = (kind: string, symbols: { location: coc.Location }[]) => symbols
            .filter(s => doc != null && s.location.uri === doc.uri)
            .map(s => ({ buffer: bufnr, group: GROUP, name: kind, lnum: s.location.range.start.line + 1, priority: 10 }));
        const signs = enabled && doc != null ? [...at("SpringBean", this.symbols.beans), ...at("SpringMapping", this.symbols.mappings)] : [];
        await coc.workspace.nvim.call("sign_unplace", [GROUP, { buffer: bufnr }]);
        await coc.workspace.nvim.call("sign_placelist", [signs]);
        return signs.length;
    }

    public async placeAll(): Promise<void> {
        for (const doc of coc.workspace.documents) {
            await this.place(doc.bufnr);
        }
    }
}

/**
 * Reveals the bean or the endpoint under the cursor in its view.
 */
async function showUnderCursor(d: Dashboard): Promise<string | undefined> {
    const doc = await coc.workspace.document;
    const pos = await coc.window.getCursorPosition();
    const on = (s: { location: coc.Location }) => s.location.uri === doc.uri && s.location.range.start.line <= pos.line && pos.line <= s.location.range.end.line;
    const bean = d.symbols.beans.find(on);
    const mapping = bean ? undefined : d.symbols.mappings.find(on);
    const id: string = bean ? "spring.beans" : "spring.mappings";
    const view = d.views.get(id);
    const key: string | undefined = bean ? bean.id : mapping?.label;
    const element: unknown = key !== undefined ? d.finders.get(id)?.(key) : undefined;
    if (view && element) {
        await focusView(view);
        await view.reveal(element, { select: true, focus: true });
    } else {
        coc.window.showWarningMessage("No bean or endpoint here");
    }
    return element ? key : undefined;
}

export function registerGutter(d: Dashboard): Gutter {
    const gutter = new Gutter(d.symbols);
    gutter.define().then(() => gutter.placeAll()).catch(() => undefined);
    d.context.subscriptions.push(
        d.symbols.onDidChange(() => gutter.placeAll()),
        coc.events.on("BufEnter", async (bufnr: number) => { await gutter.place(bufnr); }),
        coc.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration("spring.dashboard.enableGutter")) gutter.placeAll(); }),
        coc.commands.registerCommand("spring.dashboard.showUnderCursor", () => need("spring") ? showUnderCursor(d) : undefined),
    );
    return gutter;
}
