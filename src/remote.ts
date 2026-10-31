import * as coc from "coc.nvim";
import { Dashboard } from "./dashboard";
import { need } from "./ready";

interface RemoteApp {
    jmxurl: string;
    host: string;
    port?: string;
    urlScheme?: string;
}

const OWNER: string = "coc-spring-dashboard";

/**
 * Connects and disconnects the remote apps of `boot-java.remote-apps` through the live data of the language server.
 */
export function registerRemote(d: Dashboard): void {
    const connected: RemoteApp[] = [];
    const label = (a: RemoteApp) => `${a.host} (${a.jmxurl})`;
    const send = () => coc.commands.executeCommand("sts/livedata/remoteConnect", OWNER, connected);
    const connect = async (): Promise<string | undefined> => {
        const apps: RemoteApp[] = coc.workspace.getConfiguration("boot-java").get<RemoteApp[]>("remote-apps", []).filter(a => !connected.some(c => c.jmxurl === a.jmxurl));
        let picked: { label: string; app: RemoteApp } | undefined;
        if (apps.length === 0) {
            coc.window.showWarningMessage("No remote app to connect");
        } else {
            picked = await coc.window.showQuickPick(apps.map(a => ({ label: label(a), app: a })), { title: "Connect a remote app" });
            if (picked) {
                connected.push(picked.app);
                await send();
                coc.window.showInformationMessage(`Connecting ${label(picked.app)}`);
            }
        }
        return picked ? label(picked.app) : undefined;
    };
    const disconnect = async (): Promise<string | undefined> => {
        let picked: { label: string; app: RemoteApp } | undefined;
        if (connected.length === 0) {
            coc.window.showWarningMessage("No remote app to disconnect");
        } else {
            picked = await coc.window.showQuickPick(connected.map(a => ({ label: label(a), app: a })), { title: "Disconnect a remote app" });
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
