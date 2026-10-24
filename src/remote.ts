import * as coc from "coc.nvim";
import { Dashboard } from "./dashboard";

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
    d.context.subscriptions.push(
        coc.commands.registerCommand("spring.remoteApp.connect", async () => {
            const apps: RemoteApp[] = coc.workspace.getConfiguration("boot-java").get<RemoteApp[]>("remote-apps", []).filter(a => !connected.some(c => c.jmxurl === a.jmxurl));
            let picked: { label: string; app: RemoteApp } | undefined;
            if (apps.length === 0) {
                coc.window.showWarningMessage("No remote apps to connect, add them to boot-java.remote-apps");
            } else {
                picked = await coc.window.showQuickPick(apps.map(a => ({ label: label(a), app: a })), { title: "Connect a remote app" });
            }
            if (picked) {
                connected.push(picked.app);
                await send();
            }
            return picked ? label(picked.app) : undefined;
        }),
        coc.commands.registerCommand("spring.remoteApp.disconnect", async () => {
            const picked = connected.length > 0 ? await coc.window.showQuickPick(connected.map(a => ({ label: label(a), app: a })), { title: "Disconnect a remote app" }) : undefined;
            if (picked) {
                connected.splice(connected.indexOf(picked.app), 1);
                await send();
            }
            return picked ? label(picked.app) : undefined;
        }),
    );
}
