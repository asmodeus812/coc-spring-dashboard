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
const row = (a: RemoteApp) => ({ label: a.host, description: a.jmxurl, app: a });
const changed = new coc.Emitter<void>();
/** Fires when the list of what the dashboard connected changes. */
export const onDidChangeRemote: coc.Event<void> = changed.event;
const send = async (): Promise<void> => {
    await coc.commands.executeCommand("sts/livedata/remoteConnect", OWNER, connected);
    changed.fire();
};

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
export async function connectJmx(host: string, jmxPort: string, projectName: string): Promise<void> {
    const jmxurl: string = `service:jmx:rmi:///jndi/rmi://${host}:${jmxPort}/jmxrmi`;
    await replace({ jmxurl, host, projectName, manualConnect: false }, c => c.jmxurl === jmxurl);
}

/**
 * The address (`host:port`) of the remote app Attach connected for a project, undefined when there is none. The
 * language server reports a JMX connection by its address only, the project picked in the attach panel ties it to the
 * apps of that project.
 */
export function attachedAddress(projectName: string): string | undefined {
    const entry: RemoteApp | undefined = connected.find(c => c.jmxurl !== undefined && c.projectName === projectName);
    return entry?.jmxurl?.match(/rmi:\/\/([^/]+)\/jmxrmi/)?.[1];
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

const configuredApps = (): RemoteApp[] => coc.workspace.getConfiguration("boot-java").get<RemoteApp[]>("remote-apps", []);

/**
 * Connects the live data of the apps of `boot-java.remote-apps` (no discovery), and disconnects any remote app the
 * dashboard connected, from that list or by Attach; a local app is never offered, it follows its own start and stop.
 */
export function registerRemote(d: Dashboard): void {
    const connect = async (): Promise<string | undefined> => {
        const configured: RemoteApp[] = configuredApps();
        const apps: RemoteApp[] = configured.filter(a => !connected.some(c => c.jmxurl === a.jmxurl));
        let picked: { label: string; app: RemoteApp } | undefined;
        if (configured.length === 0) {
            coc.window.showWarningMessage("No remote app configured");
        } else if (apps.length === 0) {
            coc.window.showWarningMessage("No remote app to connect");
        } else {
            picked = await coc.window.showQuickPick(apps.map(row), { title: "Connect a remote app" });
            if (picked) {
                connected.push({ ...picked.app, manualConnect: false });
                await send();
                coc.window.showInformationMessage(`Connecting ${label(picked.app)}`);
            }
        }
        return picked ? label(picked.app) : undefined;
    };
    const disconnect = async (): Promise<string | undefined> => {
        // every remote app the dashboard connected, by Attach or from the list; never a local app (a pid entry)
        const remote: RemoteApp[] = connected.filter(a => a.jmxurl !== undefined);
        let picked: { label: string; app: RemoteApp } | undefined;
        if (remote.length === 0) {
            coc.window.showWarningMessage("No remote app connected");
        } else {
            picked = await coc.window.showQuickPick(remote.map(row), { title: "Disconnect a remote app" });
            if (picked) {
                connected.splice(connected.indexOf(picked.app), 1);
                await send();
                coc.window.showInformationMessage(`Disconnected ${label(picked.app)}`);
            }
        }
        return picked ? label(picked.app) : undefined;
    };
    d.context.subscriptions.push(
        coc.commands.registerCommand("spring-boot-dashboard.app.remote.connect", () => need("spring") ? connect() : undefined),
        coc.commands.registerCommand("spring-boot-dashboard.app.remote.disconnect", () => need("spring") ? disconnect() : undefined),
    );
}
