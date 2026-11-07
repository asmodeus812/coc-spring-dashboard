import * as coc from "coc.nvim";
import { AttachOptions } from "./launch";
import { Row, row, showPanel } from "./panel";
import { config } from "./util";

/**
 * The keys of `attach.defaults` and of an entry of `attach.settings`: the host, the JMX port of the live data and the
 * JDWP port of the debugger, an empty port skips that half, and the JVM options an app needs for each half.
 */
export interface AttachSettings {
    host: string;
    jmxPort: string;
    debugPort: string;
    jmxVmArgs: string[];
    debugVmArgs: string[];
}

/**
 * The settings of an attach to a project.
 */
export interface RemoteTarget extends AttachSettings {
    project: string;
}

/** What the attach panel edits and an attach remembers. */
type Remembered = Pick<AttachSettings, "host" | "jmxPort" | "debugPort">;

const EMPTY: AttachSettings = { host: "", jmxPort: "", debugPort: "", jmxVmArgs: [], debugVmArgs: [] };
const LABELS: Record<keyof Remembered, string> = { host: "Host", jmxPort: "JMX port (empty: skip)", debugPort: "Debug port (empty: skip)" };

function rememberedKey(project: string): string {
    return `attach.${project}`;
}

/**
 * The settings of a project: its entry of `attach.settings` with what an attach remembered on top, over
 * `attach.defaults`. A key that is set replaces the one below, an empty port too.
 */
export function attachSettings(state: coc.Memento, project: string): RemoteTarget {
    const configured: Partial<AttachSettings> | undefined = config<Record<string, Partial<AttachSettings>>>("attach.settings", {})[project];
    return { ...EMPTY, ...config<Partial<AttachSettings>>("attach.defaults", {}), ...configured, ...state.get<Remembered>(rememberedKey(project)), project };
}

/**
 * Remembers the host and the ports of an attach for its project.
 */
export async function rememberAttach(state: coc.Memento, s: RemoteTarget): Promise<void> {
    const remembered: Remembered = { host: s.host, jmxPort: s.jmxPort, debugPort: s.debugPort };
    await state.update(rememberedKey(s.project), remembered);
}

/**
 * The options given to the attach command over the settings of the project.
 */
export function withOptions(s: RemoteTarget, options: AttachOptions): RemoteTarget {
    const text = (value: string | number | undefined, fallback: string): string => (value === undefined ? fallback : String(value).trim());
    return { ...s, host: text(options.host, s.host), jmxPort: text(options.jmxPort, s.jmxPort), debugPort: text(options.debugPort, s.debugPort) };
}

/**
 * The JVM options an app needs to be attached to: the `debugVmArgs`, then the `jmxVmArgs`, with `${host}`, `${jmxPort}`
 * and `${debugPort}` filled in, a half with an empty port left out.
 */
export function startOptions(s: AttachSettings): string[] {
    const fill = (items: string[]): string[] => items.map(a => a.replace(/\$\{(host|jmxPort|debugPort)\}/g, (_, key: keyof Remembered) => s[key]));
    return [...(s.debugPort !== "" ? fill(s.debugVmArgs) : []), ...(s.jmxPort !== "" ? fill(s.jmxVmArgs) : [])];
}

/**
 * The attach panel, in the style of the launch panel. It saves nothing, an attach remembers its settings.
 */
export class AttachPanel {
    constructor(private readonly state: coc.Memento) { }

    /**
     * Shows the panel with the settings of the only project, picking a project shows its settings. The settings when
     * the action is picked, undefined on Esc.
     */
    public async open(projects: string[]): Promise<RemoteTarget | undefined> {
        const initial: RemoteTarget = attachSettings(this.state, projects.length === 1 ? projects[0] : "");
        return showPanel("Attach to a remote app", "Attach", initial, s => this.rows(s), (s, key) => this.edit(s, key, projects));
    }

    private rows(s: RemoteTarget): Row[] {
        return [
            row("Host", s.host, "host"),
            row("JMX port", `${s.jmxPort || "none"}  (live data; empty: skip)`, "jmxPort"),
            row("Debug port", `${s.debugPort || "none"}  (debugger; empty: skip)`, "debugPort"),
            row("Project", s.project || "none", "project"),
            row("Copy app startup options", "", "copy"),
        ];
    }

    private async edit(s: RemoteTarget, key: string, projects: string[]): Promise<RemoteTarget> {
        let result: RemoteTarget = s;
        if (key === "copy") {
            await copy(startOptions(s).join(" "));
        } else if (key === "project") {
            // a pick of the Java projects, a name to type while there are none
            const picked: string | undefined = projects.length > 0
                ? (await coc.window.showQuickPick(projects.map(p => ({ label: p })), { title: "Project to attach" }))?.label
                : (await coc.window.requestInput("Project", s.project))?.trim();
            result = picked === undefined || picked === "" ? s : attachSettings(this.state, picked);
        } else {
            const field = key as keyof Remembered;
            const input: string | undefined = await coc.window.requestInput(LABELS[field], s[field]);
            const value: string = (input ?? s[field]).trim();
            // a port is a number or empty, the host is not empty, anything else keeps the value
            const valid: boolean = field === "host" ? value !== "" : /^\d*$/.test(value);
            result = valid ? { ...s, [field]: value } : s;
        }
        return result;
    }
}

/**
 * Puts the text on the clipboard and in the unnamed register, the system clipboard may be missing.
 */
async function copy(text: string): Promise<void> {
    for (const register of ["+", "\""]) {
        await coc.workspace.nvim.call("setreg", [register, text]).catch(() => undefined);
    }
    void coc.window.showInformationMessage("App startup options copied");
}
