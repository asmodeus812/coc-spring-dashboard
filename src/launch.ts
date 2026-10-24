import * as coc from "coc.nvim";

/**
 * The part of an app that a launch needs: the main class and the jdtls project it belongs to.
 */
export interface LaunchTarget {
    name: string;
    mainClass: string;
    projectName: string;
}

/**
 * The java launch configuration of an app, the same one upstream hands to vscode-java-debug.
 */
export interface LaunchConfig {
    type: "java";
    name: string;
    request: "launch";
    mainClass: string;
    projectName: string;
    vmArgs: string;
}

/**
 * Starts, debugs and stops the apps. Every command, tree action and app state goes through it.
 */
export interface AppLauncher {
    run(app: LaunchTarget, profile?: string): Promise<string>;
    debug(app: LaunchTarget, profile?: string): Promise<string>;
    stop(app: LaunchTarget): Promise<string>;
}

const JMX_ARGS: string[] = [
    "-Dspring.jmx.enabled=true",
    "-Dmanagement.endpoints.jmx.exposure.include=*",
];

/**
 * Builds the launch configuration of an app. JMX is always enabled so that the live data of the language server can
 * connect to it, a profile becomes the active spring profile.
 */
export function buildLaunchConfig(app: LaunchTarget, profile?: string): LaunchConfig {
    const vmArgs: string[] = [...JMX_ARGS];
    if (profile && profile.trim().length > 0) {
        vmArgs.push(`-Dspring.profiles.active=${profile.trim()}`);
    }
    return {
        type: "java",
        name: `Spring Boot-${app.name}`,
        request: "launch",
        mainClass: app.mainClass,
        projectName: app.projectName,
        vmArgs: vmArgs.join(" "),
    };
}

/**
 * The launcher until running and debugging is implemented: every operation only says so.
 */
export class PlaceholderLauncher implements AppLauncher {

    public async run(_app: LaunchTarget, _profile?: string): Promise<string> {
        return this.notImplemented("Run");
    }

    public async debug(_app: LaunchTarget, _profile?: string): Promise<string> {
        return this.notImplemented("Debug");
    }

    public async stop(_app: LaunchTarget): Promise<string> {
        return this.notImplemented("Stop");
    }

    private notImplemented(operation: string): string {
        const message: string = `${operation} is not implemented yet`;
        coc.window.showWarningMessage(message);
        return message;
    }
}
