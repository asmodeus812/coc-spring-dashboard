import * as coc from "coc.nvim";
import { Dashboard } from "./dashboard";
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
            .filter(s => s.location.uri === doc?.uri)
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

export function registerGutter(d: Dashboard): Gutter {
    const gutter = new Gutter(d.symbols);
    gutter.define().then(() => gutter.placeAll()).catch(() => undefined);
    d.context.subscriptions.push(
        d.symbols.onDidChange(() => gutter.placeAll().catch(() => undefined)),
        coc.events.on("BufEnter", async (bufnr: number) => { await gutter.place(bufnr); }),
        coc.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration("spring.dashboard.enableGutter")) gutter.placeAll().catch(() => undefined); }),
    );
    return gutter;
}
