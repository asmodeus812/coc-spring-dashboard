import * as coc from "coc.nvim";
import { sleep } from "./util";

const CHECK_MS: number = 2000;

/**
 * A language server the dashboard depends on. It is ready when its commands are registered, which coc knows locally, so
 * asking never sends a request to the server.
 */
export type Server = "java" | "spring";

/** A command each server registers once it runs: jdtls its workspace command, the spring boot server its live data commands. */
const COMMAND: Record<Server, string> = {
    java: "java.execute.workspaceCommand",
    spring: "sts/livedata/listProcesses",
};

const NOT_READY: Record<Server, string> = {
    java: "Java server starting",
    spring: "Spring Boot server not running",
};

/** Whether the server of coc-java or coc-springboot is up. */
export function ready(server: Server): boolean {
    return coc.commands.has(COMMAND[server]);
}

/**
 * Waits until a server is ready, checked locally every 2 s. False when it is not ready within the timeout or `stopped`
 * says the waiting is over.
 */
export async function waitFor(server: Server, stopped: () => boolean = () => false, timeout: number = 600000): Promise<boolean> {
    const until: number = Date.now() + timeout;
    while (!ready(server) && Date.now() < until && !stopped()) {
        await sleep(CHECK_MS);
    }
    return ready(server);
}

/**
 * Whether a server is ready, says so when it is not. For the actions that need it.
 */
export function need(server: Server): boolean {
    const ok: boolean = ready(server);
    if (!ok) {
        coc.window.showWarningMessage(NOT_READY[server]);
    }
    return ok;
}
