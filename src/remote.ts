import * as coc from "coc.nvim";
import { Dashboard } from "./dashboard";
import { need } from "./ready";

interface RemoteApp {
    jmxurl?: string;
    processId?: string;
    processName?: string;
    projectName?: string;
    host: string;
    port?: string;
    urlScheme?: string;
    manualConnect?: boolean;
}

const OWNER: string = "coc-spring-dashboard";
const connected: RemoteApp[] = [];
const label = (a: RemoteApp) => `${a.host} (${a.jmxurl ?? a.processId})`;
const send = () => coc.commands.executeCommand("sts/livedata/remoteConnect", OWNER, connected);

/**
 * Puts an entry in the list and sends it, the entry it replaces is taken out.
 */
async function replace(entry: RemoteApp, same: (c: RemoteApp) => boolean): Promise<void> {
    const at: number = connected.findIndex(same);
    if (at >= 0) {
        connected.splice(at, 1);
    }
    connected.push(entry);
    await send();
}

/**
 * Connects the live data of a JMX port, like a remote app of the settings. `manualConnect` is false, the language
 * server skips an entry with true.
 */
export async function connectJmx(host: string, jmxPort: string): Promise<void> {
    const jmxurl: string = `service:jmx:rmi:///jndi/rmi://${host}:${jmxPort}/jmxrmi`;
    await replace({ jmxurl, host, manualConnect: false }, c => c.jmxurl === jmxurl);
}

/**
 * Connects the live data of an app the dashboard started by its local pid, the language server attaches to it without
 * its setting for all local java processes. It shares the list of the remote apps, `manualConnect` is false.
 */
export async function connectPid(pid: number, processName: string, projectName: string): Promise<void> {
    const processId: string = String(pid);
    await replace({ processId, processName, projectName, host: "localhost", manualConnect: false }, c => c.processId === processId);
}

/**
 * Takes a started app out of the list when it stops.
 */
export async function disconnectPid(pid: number): Promise<void> {
    const at: number = connected.findIndex(c => c.processId === String(pid));
    if (at >= 0) {
        connected.splice(at, 1);
        await send();
    }
}

/**
 * Connects and disconnects the remote apps of `boot-java.remote-apps` through the live data of the language server.
 */
export function registerRemote(d: Dashboard): void {
    const connect = async (): Promise<string | undefined> => {
        const apps: RemoteApp[] = coc.workspace.getConfiguration("boot-java").get<RemoteApp[]>("remote-apps", []).filter(a => !connected.some(c => c.jmxurl === a.jmxurl));
        let picked: { label: string; app: RemoteApp } | undefined;
        if (apps.length === 0) {
            coc.window.showWarningMessage("No remote app to connect");
        } else {
            picked = await coc.window.showQuickPick(apps.map(a => ({ label: label(a), app: a })), { title: "Connect a remote app" });
            if (picked) {
                connected.push({ ...picked.app, manualConnect: false });
                await send();
                coc.window.showInformationMessage(`Connecting ${label(picked.app)}`);
            }
        }
        return picked ? label(picked.app) : undefined;
    };
    const disconnect = async (): Promise<string | undefined> => {
        const remote: RemoteApp[] = connected.filter(a => a.jmxurl !== undefined);
        let picked: { label: string; app: RemoteApp } | undefined;
        if (remote.length === 0) {
            coc.window.showWarningMessage("No remote app to disconnect");
        } else {
            picked = await coc.window.showQuickPick(remote.map(a => ({ label: label(a), app: a })), { title: "Disconnect a remote app" });
            if (picked) {
                connected.splice(connected.indexOf(picked.app), 1);
                await send();
                coc.window.showInformationMessage(`Disconnected ${label(picked.app)}`);
            }
        }
        return picked ? label(picked.app) : undefined;
    };
    d.context.subscriptions.push(
        coc.commands.registerCommand("spring.remoteApp.connect", () => need("spring") ? connect() : undefined),
        coc.commands.registerCommand("spring.remoteApp.disconnect", () => need("spring") ? disconnect() : undefined),
    );
}
