import * as coc from "coc.nvim";
import { LaunchTarget } from "./launch";
import { Row, joinArgs, row, showPanel } from "./panel";
import { discoverProfiles } from "./profiles";
import { config, splitArgs } from "./util";

/**
 * The keys of `launch.defaults` and of an entry of `launch.settings`. An empty value is not set.
 */
export interface LaunchSettings {
    profiles: string[];
    /** Empty for the default of the app, 0 for a random port, or a number. */
    port: string;
    logLevel: string;
    /** Per package levels: `com.example=DEBUG org.foo=TRACE`. */
    logPackages: string;
    debugReport: boolean;
    vmArgs: string[];
    programArgs: string[];
    envVars: Record<string, string>;
}

/**
 * What the settings of a launch turn into: the JVM options, the program arguments and the environment of the JVM.
 */
export interface LaunchArguments {
    vmArgs: string[];
    programArgs: string[];
    envVars: Record<string, string>;
}

const EMPTY: LaunchSettings = { profiles: [], port: "", logLevel: "", logPackages: "", debugReport: false, vmArgs: [], programArgs: [], envVars: {} };
const LEVELS: string[] = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];
const OTHER: string = "Type another profile...";
type TextKey = "vmArgs" | "programArgs" | "envVars";
const TEXT_LABELS: Record<TextKey, string> = { vmArgs: "JVM options", programArgs: "Program arguments", envVars: "Environment (KEY=VALUE ...)" };

function rememberedKey(app: LaunchTarget): string {
    return `launch.${app.mainClass}`;
}

function typedKey(app: LaunchTarget): string {
    return `launch.${app.mainClass}.typed`;
}

/**
 * The settings of an app before `launch.defaults`: its entry of `launch.settings` with what the launch panel remembered
 * on top.
 */
export function launchSettings(state: coc.Memento, app: LaunchTarget): LaunchSettings {
    const configured: Partial<LaunchSettings> | undefined = config<Record<string, Partial<LaunchSettings>>>("launch.settings", {})[app.name];
    return { ...EMPTY, ...configured, ...state.get<Partial<LaunchSettings>>(rememberedKey(app)) };
}

/**
 * Whether the launch panel remembered settings for the app.
 */
export function isRemembered(state: coc.Memento, app: LaunchTarget): boolean {
    return state.get(rememberedKey(app)) !== undefined;
}

/**
 * The entries of the lists in order, an entry with the key of an earlier one replaces it and takes the later position.
 */
function unique(items: string[], key: (item: string) => string): string[] {
    const kept: Map<string, string> = new Map();
    for (const item of items) {
        kept.delete(key(item));
        kept.set(key(item), item);
    }
    return [...kept.values()];
}

/**
 * The settings of an app over `launch.defaults`: JVM options without exact duplicates, program arguments unique by
 * option name (before `=`), profiles unique, the environment per variable, a single value the app sets (not empty, not
 * off) replaces the default.
 */
export function withLaunchDefaults(own: LaunchSettings): LaunchSettings {
    const defaults: LaunchSettings = { ...EMPTY, ...config<Partial<LaunchSettings>>("launch.defaults", {}) };
    return {
        profiles: unique([...defaults.profiles, ...own.profiles], p => p),
        port: own.port || defaults.port,
        logLevel: own.logLevel || defaults.logLevel,
        logPackages: own.logPackages || defaults.logPackages,
        debugReport: own.debugReport || defaults.debugReport,
        vmArgs: unique([...defaults.vmArgs, ...own.vmArgs], a => a),
        programArgs: unique([...defaults.programArgs, ...own.programArgs], a => a.split("=")[0]),
        envVars: { ...defaults.envVars, ...own.envVars },
    };
}

/**
 * The command line of the settings: the JVM options, the profiles, port and log levels as `-D` options, the program
 * arguments with `--debug` for the debug report, and the environment.
 */
export function launchArguments(s: LaunchSettings): LaunchArguments {
    const vmArgs: string[] = [...s.vmArgs];
    if (s.profiles.length > 0) {
        vmArgs.push(`-Dspring.profiles.active=${s.profiles.join(",")}`);
    }
    if (s.port !== "") {
        vmArgs.push(`-Dserver.port=${s.port}`);
    }
    if (s.logLevel !== "") {
        vmArgs.push(`-Dlogging.level.root=${s.logLevel}`);
    }
    vmArgs.push(...splitArgs(s.logPackages).map(p => `-Dlogging.level.${p}`));
    return { vmArgs, programArgs: s.debugReport ? [...s.programArgs, "--debug"] : [...s.programArgs], envVars: { ...s.envVars } };
}

/**
 * A list or the environment as one line of text.
 */
function textOf(s: LaunchSettings, key: TextKey): string {
    return joinArgs(key === "envVars" ? Object.entries(s.envVars).map(([k, v]) => `${k}=${v}`) : s[key]);
}

/**
 * `KEY=VALUE` pairs as an environment.
 */
function envOf(pairs: string[]): Record<string, string> {
    const env: Record<string, string> = {};
    for (const pair of pairs) {
        const at: number = pair.indexOf("=");
        if (at > 0) {
            env[pair.substring(0, at)] = pair.substring(at + 1);
        }
    }
    return env;
}

/**
 * The launch panel of an app: it edits the settings of the app, `launch.defaults` joins them at launch. Picking the
 * action remembers them per app in the workspace state.
 */
export class LaunchPanel {
    constructor(private readonly state: coc.Memento) { }

    /**
     * Shows the panel with the settings, `section` opens the editor of a setting first. The settings when the action is
     * picked, undefined on Esc.
     */
    public async open(app: LaunchTarget, action: string, initial: LaunchSettings, section?: "profiles"): Promise<LaunchSettings | undefined> {
        const first: LaunchSettings = section === "profiles" ? await this.editProfiles(app, initial) : initial;
        const title: string = action === "Save" ? `Launch settings ${app.name}` : `${action} ${app.name}`;
        const result: LaunchSettings | undefined = await showPanel(title, action, first, s => this.rows(s), (s, key) => this.edit(app, s, key));
        if (result !== undefined) {
            await this.state.update(rememberedKey(app), result);
        }
        return result;
    }

    private rows(s: LaunchSettings): Row[] {
        return [
            row("Profiles", s.profiles.join(", ") || "none", "profiles"),
            row("Server port", s.port === "" ? "default" : (s.port === "0" ? "random (0)" : s.port), "port"),
            row("Logging", `${s.logLevel || "unset"}${s.logPackages ? ` ${s.logPackages}` : ""} (debug report: ${s.debugReport ? "on" : "off"})`, "logging"),
            row("JVM options", textOf(s, "vmArgs") || "none", "vmArgs"),
            row("Program args", textOf(s, "programArgs") || "none", "programArgs"),
            row("Environment", textOf(s, "envVars") || "none", "envVars"),
            row("Reset to settings", "", "reset"),
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
            result = { ...EMPTY, ...config<Record<string, Partial<LaunchSettings>>>("launch.settings", {})[app.name] };
        } else {
            const textKey = key as TextKey;
            const input: string | undefined = await coc.window.requestInput(`${TEXT_LABELS[textKey]} of ${app.name}`, textOf(s, textKey));
            const items: string[] = splitArgs(input ?? "");
            result = input === undefined ? s : { ...s, [textKey]: textKey === "envVars" ? envOf(items) : items };
        }
        return result;
    }

    /**
     * The profiles found in the project, typed before and set, the typed ones are offered again next time.
     */
    private async editProfiles(app: LaunchTarget, s: LaunchSettings): Promise<LaunchSettings> {
        const typedBefore: string[] = this.state.get<string[]>(typedKey(app), []);
        const known: string[] = [...new Set([...await discoverProfiles(app), ...typedBefore, ...s.profiles])];
        const picked = await coc.window.showQuickPick([...known.map(p => ({ label: p, picked: s.profiles.includes(p) })), { label: OTHER }], { canPickMany: true, title: `Profiles of ${app.name}` });
        let result: LaunchSettings = s;
        if (picked !== undefined) {
            const input: string | undefined = picked.some(p => p.label === OTHER) ? await coc.window.requestInput("Profiles (comma separated)") : undefined;
            const typed: string[] = (input ?? "").split(",").map(p => p.trim()).filter(p => p.length > 0);
            await this.state.update(typedKey(app), [...new Set([...typedBefore, ...typed])]);
            result = { ...s, profiles: [...new Set([...picked.filter(p => p.label !== OTHER).map(p => p.label), ...typed])] };
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
