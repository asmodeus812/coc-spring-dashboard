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
 * How a launch differs from the remembered settings: profiles that replace them, or the panel opened with the profiles.
 */
export interface LaunchOptions {
    profile?: string;
    pickProfiles?: boolean;
}

/**
 * Where an app is in its life, as far as the dashboard started it.
 */
export type AppState = "starting" | "waiting" | "running" | "debugging" | "stopped";

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
    /** Whether the app has a dashboard tab, or a terminal of its last run to build one from. */
    hasOutput(app: LaunchTarget): Promise<boolean>;
    /** Attaches the debugger to an app that was started with run. */
    attach(app: LaunchTarget): Promise<string>;
    /** Stops an app, `pid` is the process of an app the dashboard did not start. */
    stop(app: LaunchTarget, pid?: number): Promise<string>;
    state(app: LaunchTarget): AppState;
    /** The pid of the JVM the dashboard started for the app. */
    pidOf(app: LaunchTarget): number | undefined;
}

/**
 * The JMX setup the spring boot language server connects through, the same set upstream adds to every launch: a remote
 * JMX port without authentication on localhost, spring's JMX beans and admin endpoint, and the project name.
 */
export function jmxArgs(projectName: string, jmxPort: number): string[] {
    return [
        "-Dcom.sun.management.jmxremote",
        `-Dcom.sun.management.jmxremote.port=${jmxPort}`,
        "-Dcom.sun.management.jmxremote.authenticate=false",
        "-Dcom.sun.management.jmxremote.ssl=false",
        "-Djava.rmi.server.hostname=localhost",
        "-Dspring.jmx.enabled=true",
        "-Dspring.application.admin.enabled=true",
        "-Dmanagement.endpoints.jmx.exposure.include=*",
        `-Dspring.boot.project.name=${projectName}`,
    ];
}
