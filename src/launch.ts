import * as coc from "coc.nvim";

/**
 * The part of an app that a launch needs: the main class and the jdtls project it belongs to.
 */
export interface LaunchTarget {
    name: string;
    mainClass: string;
    projectName: string;
    /** The project folder, the working directory of the JVM. */
    path: string;
}

/**
 * How a launch differs from the settings of the app (remembered or configured): profiles that replace them, or the panel opened with the profiles.
 */
export interface LaunchOptions {
    profile?: string;
    pickProfiles?: boolean;
}

/**
 * Where to attach to an app the dashboard did not start. Any part given skips the attach panel, a part that is not
 * given comes from the settings of the project.
 */
export interface AttachOptions {
    host?: string;
    jmxPort?: string;
    debugPort?: string;
    project?: string;
}

/**
 * A Java project to attach to: its name in jdtls and its folder.
 */
export interface AttachProject {
    name: string;
    path: string;
}

/**
 * Where an app is in its life, as far as the dashboard started it.
 */
export type AppState = "starting" | "waiting" | "running" | "debugging" | "attached" | "stopped";

/**
 * Starts, debugs and stops the apps. Every command, tree action and app state goes through it.
 */
export interface AppLauncher {
    readonly onDidChangeState: coc.Event<void>;
    run(app: LaunchTarget, options?: LaunchOptions): Promise<string>;
    debug(app: LaunchTarget, options?: LaunchOptions): Promise<string>;
    /** Opens the launch settings panel of an app without launching. */
    configure(app: LaunchTarget): Promise<string>;
    /** Switches to the dashboard tab of an app. */
    showOutput(app: LaunchTarget): Promise<string>;
    /** Whether the app has a dashboard tab, or a terminal of its running JVM to build one from. */
    hasOutput(app: LaunchTarget): Promise<boolean>;
    /** Attaches the debugger to an app that was started with run. */
    attach(app: LaunchTarget): Promise<string>;
    /** Connects the live data and attaches the debugger to an app the dashboard did not start. */
    attachRemote(options: AttachOptions, projects: AttachProject[]): Promise<string>;
    /** Stops an app, `pid` is the process of an app the dashboard did not start. */
    stop(app: LaunchTarget, pid?: number): Promise<string>;
    state(app: LaunchTarget): AppState;
    /** The pid of the JVM the dashboard started for the app. */
    pidOf(app: LaunchTarget): number | undefined;
}

/**
 * The per run part of the JMX setup the spring boot language server connects through: the port, the host and the
 * project name. The rest comes with the JVM options of `launch.defaults`.
 */
export function jmxArgs(projectName: string, jmxPort: number): string[] {
    return [
        "-Dcom.sun.management.jmxremote",
        `-Dcom.sun.management.jmxremote.port=${jmxPort}`,
        "-Djava.rmi.server.hostname=localhost",
        `-Dspring.boot.project.name=${projectName}`,
    ];
}
