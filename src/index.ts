import * as coc from "coc.nvim";
import { AppsView, registerApps } from "./apps";
import { Dashboard } from "./dashboard";
import { PlaceholderLauncher } from "./launch";
import { LiveData } from "./live";
import { waitForStsApi } from "./sts";
import { Symbols } from "./symbols";
import { registerBeans } from "./views/beans";
import { registerMappings } from "./views/mappings";
import { registerProperties } from "./views/properties";

export async function activate(context: coc.ExtensionContext): Promise<void> {
    start(context).catch(e => coc.window.showErrorMessage(`Spring Boot Dashboard: ${e}`));
}

/**
 * Waits for coc-springboot, then builds the shared state and registers the views.
 */
async function start(context: coc.ExtensionContext): Promise<void> {
    const api = await waitForStsApi();
    if (api === undefined) {
        coc.window.showWarningMessage(`Spring Boot Dashboard needs coc-springboot and coc-java, not active: ${["coc-springboot", "coc-java"].filter(id => !coc.extensions.all.find(e => e.id === id)?.isActive).join(", ")}`);
    } else {
        const live = new LiveData(api);
        const symbols = new Symbols(api);
        const d: Dashboard = { context, api, live, symbols, apps: new AppsView(live, new PlaceholderLauncher()), views: new Map(), finders: new Map() };
        context.subscriptions.push(live, symbols);
        registerApps(d);
        registerBeans(d);
        context.subscriptions.push(coc.commands.registerCommand("spring.staticData.refresh", () => d.symbols.refresh()));
        registerMappings(d);
        registerProperties(d);
        await live.init();
    }
}
