import * as coc from "coc.nvim";
import * as fs from "fs";
import * as path from "path";
import { LaunchTarget } from "./launch";
import { config, javaCommand, splitArgs } from "./util";

/**
 * The launch settings of an app, remembered per app. An empty value is not set.
 */
export interface LaunchSettings {
    profiles: string[];
    /** Profiles typed in the panel, offered again next time. */
    typed: string[];
    /** Empty for the default of the app, 0 for a random port, or a number. */
    port: string;
    logLevel: string;
    /** Per package overrides: `com.example=DEBUG org.foo=TRACE`. */
    logPackages: string;
    debugReport: boolean;
    vmArgs: string;
    args: string;
    /** `KEY=VALUE` pairs. */
    env: string;
}

/**
 * What the settings turn into on the command line of the JVM.
 */
export interface LaunchArguments {
    vmArgs: string[];
    args: string[];
    env: Record<string, string>;
}

const LEVELS: string[] = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];
const RESOURCES: string = path.join("src", "main", "resources");
const OTHER: string = "Type another profile...";

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

/**
 * The settings an app starts with: `spring.dashboard.apps` over the empty settings.
 */
export function defaultSettings(app: LaunchTarget): LaunchSettings {
    const preset: Partial<LaunchSettings> = config<Record<string, Partial<LaunchSettings>>>("apps", {})[app.name] ?? {};
    return { profiles: [], port: "", logLevel: "", logPackages: "", debugReport: false, vmArgs: "", args: "", env: "", ...preset, typed: [] };
}

/**
 * The JVM options, program arguments and environment of the settings. The JMX flags and the JDWP agent are not part of it.
 */
export function launchArguments(settings: LaunchSettings): LaunchArguments {
    const vmArgs: string[] = splitArgs(settings.vmArgs);
    const args: string[] = splitArgs(settings.args);
    if (settings.profiles.length > 0) {
        vmArgs.push(`-Dspring.profiles.active=${settings.profiles.join(",")}`);
    }
    if (settings.port !== "") {
        vmArgs.push(`-Dserver.port=${settings.port}`);
    }
    if (settings.logLevel !== "") {
        vmArgs.push(`-Dlogging.level.root=${settings.logLevel}`);
    }
    for (const override of splitArgs(settings.logPackages)) {
        vmArgs.push(`-Dlogging.level.${override}`);
    }
    if (settings.debugReport) {
        args.push("--debug");
    }
    const env: Record<string, string> = {};
    for (const pair of splitArgs(settings.env)) {
        const at: number = pair.indexOf("=");
        if (at > 0) {
            env[pair.substring(0, at)] = pair.substring(at + 1);
        }
    }
    return { vmArgs, args, env };
}

interface Row {
    label: string;
    key: string;
}

type TextKey = "vmArgs" | "args" | "env";

const TEXT_LABELS: Record<TextKey, string> = { vmArgs: "JVM options", args: "Program arguments", env: "Environment (KEY=VALUE ...)" };

/**
 * The launch panel: one quick pick per app with the action first and the settings below it. Picking a setting edits
 * it and returns to the panel, the settings are remembered per app in the workspace state.
 */
export class LaunchPanel {
    constructor(private readonly context: coc.ExtensionContext) { }

    private key(app: LaunchTarget): string {
        return `launch.settings.${app.mainClass}`;
    }

    /**
     * The remembered settings of an app, undefined when it was never launched.
     */
    public saved(app: LaunchTarget): LaunchSettings | undefined {
        const saved: Partial<LaunchSettings> | undefined = this.context.workspaceState.get<Partial<LaunchSettings>>(this.key(app));
        return saved === undefined ? undefined : { ...defaultSettings(app), ...saved };
    }

    /**
     * Shows the panel until the action is picked, which saves and returns the settings. Undefined on Esc. `section`
     * opens the editor of a setting first, `initial` replaces the remembered settings.
     */
    public async open(app: LaunchTarget, action: string, section?: "profiles", initial?: LaunchSettings): Promise<LaunchSettings | undefined> {
        let settings: LaunchSettings = initial ?? this.saved(app) ?? defaultSettings(app);
        if (section === "profiles") {
            settings = await this.editProfiles(app, settings);
        }
        let result: LaunchSettings | undefined = undefined;
        let done: boolean = false;
        while (!done) {
            const picked = await coc.window.showQuickPick([{ label: `▶ ${action} with these settings`, key: "go" }, ...this.rows(app, settings)], { title: action === "Save" ? `Launch settings ${app.name}` : `${action} ${app.name}` });
            if (picked === undefined) {
                done = true;
            } else if (picked.key === "go") {
                await this.context.workspaceState.update(this.key(app), settings);
                result = settings;
                done = true;
            } else {
                settings = await this.edit(app, settings, picked.key);
            }
        }
        return result;
    }

    private rows(app: LaunchTarget, s: LaunchSettings): Row[] {
        const row = (name: string, value: string, key: string): Row => ({ label: `  ${name.padEnd(15)}${value}`, key });
        const port: string = s.port === "" ? "default" : (s.port === "0" ? "random (0)" : s.port);
        return [
            row("Profiles", s.profiles.length > 0 ? s.profiles.join(", ") : "none", "profiles"),
            row("Server port", port, "port"),
            row("Logging", `${s.logLevel || "unset"}${s.logPackages ? ` ${s.logPackages}` : ""} (debug report: ${s.debugReport ? "on" : "off"})`, "logging"),
            row("JVM options", s.vmArgs || "none", "vmArgs"),
            row("Program args", s.args || "none", "args"),
            row("Environment", s.env || "none", "env"),
            row("Reset to defaults", "", "reset"),
        ];
    }

    private async edit(app: LaunchTarget, s: LaunchSettings, key: string): Promise<LaunchSettings> {
        let result: LaunchSettings = s;
        if (key === "profiles") {
            result = await this.editProfiles(app, s);
        } else if (key === "port") {
            result = { ...s, port: await this.editPort(app, s.port) };
        } else if (key === "logging") {
            result = await this.editLogging(s);
        } else if (key === "reset") {
            result = defaultSettings(app);
        } else {
            const textKey = key as TextKey;
            const input: string | undefined = await coc.window.requestInput(`${TEXT_LABELS[textKey]} of ${app.name}`, s[textKey]);
            result = input === undefined ? s : { ...s, [textKey]: input.trim() };
        }
        return result;
    }

    private async editProfiles(app: LaunchTarget, s: LaunchSettings): Promise<LaunchSettings> {
        const known: string[] = [...new Set([...await discoverProfiles(app), ...s.typed, ...s.profiles])];
        const picked = await coc.window.showQuickPick([...known.map(p => ({ label: p, picked: s.profiles.includes(p) })), { label: OTHER }], { canPickMany: true, title: `Profiles of ${app.name}` });
        let result: LaunchSettings = s;
        if (picked !== undefined) {
            const profiles: string[] = picked.filter(p => p.label !== OTHER).map(p => p.label);
            const typed: string[] = [];
            if (picked.some(p => p.label === OTHER)) {
                const input: string | undefined = await coc.window.requestInput("Profiles (comma separated)");
                typed.push(...(input ?? "").split(",").map(p => p.trim()).filter(p => p.length > 0));
            }
            result = { ...s, profiles: [...new Set([...profiles, ...typed])], typed: [...new Set([...s.typed, ...typed])] };
        }
        return result;
    }

    private async editPort(app: LaunchTarget, current: string): Promise<string> {
        const choices = [
            { label: "App default", value: "" },
            { label: "Random (0)", value: "0" },
            { label: "Number...", value: "number" },
        ];
        const picked = await coc.window.showQuickPick(choices, { title: `Server port of ${app.name}` });
        let result: string = current;
        if (picked !== undefined && picked.value === "number") {
            const input: string | undefined = await coc.window.requestInput("Server port", /^\d+$/.test(current) && current !== "0" ? current : "");
            result = input !== undefined && /^\d+$/.test(input.trim()) ? input.trim() : current;
        } else if (picked !== undefined) {
            result = picked.value;
        }
        return result;
    }

    private async editLogging(s: LaunchSettings): Promise<LaunchSettings> {
        const level = await coc.window.showQuickPick([{ label: "unset", value: "" }, ...LEVELS.map(l => ({ label: l, value: l }))], { title: "Root log level" });
        let result: LaunchSettings = s;
        if (level !== undefined) {
            const packages: string | undefined = await coc.window.requestInput("Package log levels (com.example=DEBUG ...)", s.logPackages);
            const report = packages === undefined ? undefined : await coc.window.showQuickPick([{ label: "off", value: false }, { label: "on", value: true }], { title: "Auto-configuration debug report (--debug)" });
            if (report !== undefined) {
                result = { ...s, logLevel: level.value, logPackages: (packages ?? "").trim(), debugReport: report.value };
            }
        }
        return result;
    }
}

/**
 * Where to attach: a host with the JMX port of the live data and the JDWP port of the debugger. An empty port skips that half.
 */
export interface AttachSettings {
    host: string;
    jmxPort: string;
    debugPort: string;
    project: string;
}

const ATTACH_DEFAULTS: AttachSettings = { host: "localhost", jmxPort: "9010", debugPort: "5005", project: "" };
const ATTACH_KEY: string = "attach.settings";

/**
 * The JVM options an app needs to be attached to with these settings. A half with an empty port is left out.
 */
export function startOptions(s: AttachSettings): string[] {
    const options: string[] = [];
    if (s.debugPort !== "") {
        options.push(`-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:${s.debugPort}`);
    }
    if (s.jmxPort !== "") {
        const host: string = s.host === "localhost" ? "127.0.0.1" : s.host;
        options.push(
            `-Dcom.sun.management.jmxremote.port=${s.jmxPort}`,
            `-Dcom.sun.management.jmxremote.rmi.port=${s.jmxPort}`,
            "-Dcom.sun.management.jmxremote.authenticate=false",
            "-Dcom.sun.management.jmxremote.ssl=false",
            `-Djava.rmi.server.hostname=${host}`,
            "-Dspring.jmx.enabled=true",
            "-Dmanagement.endpoints.jmx.exposure.include=*",
        );
    }
    return options;
}

/**
 * The attach panel, in the style of the launch panel: the action first and the settings below it, remembered in the
 * workspace state.
 */
export class AttachPanel {
    constructor(private readonly context: coc.ExtensionContext) { }

    public saved(): AttachSettings {
        return { ...ATTACH_DEFAULTS, ...this.context.workspaceState.get<Partial<AttachSettings>>(ATTACH_KEY) };
    }

    public async remember(settings: AttachSettings): Promise<void> {
        await this.context.workspaceState.update(ATTACH_KEY, settings);
    }

    /**
     * Shows the panel until the action is picked, which saves and returns the settings. Undefined on Esc. The only
     * project is filled in when none was picked yet.
     */
    public async open(projects: string[]): Promise<AttachSettings | undefined> {
        let settings: AttachSettings = this.saved();
        if (settings.project === "" && projects.length === 1) {
            settings = { ...settings, project: projects[0] };
        }
        let result: AttachSettings | undefined = undefined;
        let done: boolean = false;
        while (!done) {
            const picked = await coc.window.showQuickPick([{ label: "▶ Attach with these settings", key: "go" }, ...this.rows(settings)], { title: "Attach to an app" });
            if (picked === undefined) {
                done = true;
            } else if (picked.key === "go") {
                await this.remember(settings);
                result = settings;
                done = true;
            } else if (picked.key === "copy") {
                await this.copy(settings);
            } else {
                settings = await this.edit(settings, picked.key, projects);
            }
        }
        return result;
    }

    private rows(s: AttachSettings): Row[] {
        const row = (name: string, value: string, key: string, hint: string = ""): Row => ({ label: `  ${name.padEnd(15)}${value}${hint ? `  (${hint})` : ""}`, key });
        return [
            row("Host", s.host, "host"),
            row("JMX port", s.jmxPort || "none", "jmxPort", "live data; empty: skip"),
            row("Debug port", s.debugPort || "none", "debugPort", "debugger; empty: skip"),
            row("Project", s.project || "none", "project"),
            row("Copy the start options", "", "copy"),
        ];
    }

    private async copy(s: AttachSettings): Promise<void> {
        // one line, ready to paste into a command line or JAVA_TOOL_OPTIONS
        const text: string = startOptions(s).join(" ");
        // the system clipboard may be missing, the unnamed register always works
        for (const register of ["+", "\""]) {
            await coc.workspace.nvim.call("setreg", [register, text]).catch(() => undefined);
        }
        coc.window.showInformationMessage("Start options copied");
    }

    private async edit(s: AttachSettings, key: string, projects: string[]): Promise<AttachSettings> {
        let result: AttachSettings = s;
        if (key === "project" && projects.length > 0) {
            const picked = await coc.window.showQuickPick(projects.map(p => ({ label: p })), { title: "Project to attach" });
            result = picked === undefined ? s : { ...s, project: picked.label };
        } else {
            const label: string = { host: "Host", jmxPort: "JMX port (empty: skip)", debugPort: "Debug port (empty: skip)", project: "Project" }[key] ?? key;
            const current: string = s[key as keyof AttachSettings];
            const input: string | undefined = await coc.window.requestInput(label, current);
            const value: string = (input ?? current).trim();
            // a port is a number or empty, anything else keeps the value
            const valid: boolean = key.endsWith("Port") ? /^\d*$/.test(value) : (key !== "host" || value !== "");
            result = valid ? { ...s, [key]: value } : s;
        }
        return result;
    }
}
