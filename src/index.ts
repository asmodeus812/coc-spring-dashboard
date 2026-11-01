import * as coc from "coc.nvim";
import { AppsView, registerApps } from "./apps";
import { AppTab, Dashboard, layoutViews } from "./dashboard";
import { TerminalLauncher } from "./launcher";
import { LiveData } from "./live";
import { OutputTabs } from "./output";
import { waitFor } from "./ready";
import { waitForStsApi } from "./sts";
import { Symbols } from "./symbols";
import { registerBeans } from "./views/beans";
import { registerMappings } from "./views/mappings";
import { registerProperties } from "./views/properties";
import { registerMemory } from "./views/memory";
import { registerGutter } from "./gutter";
import { registerRemote } from "./remote";
import { registerHelp } from "./help";
import { failed } from "./util";

export async function activate(context: coc.ExtensionContext): Promise<void> {
    await registerHelp(context).catch(e => failed("help page", e, undefined));
    start(context).catch(() => coc.window.showErrorMessage("Dashboard not started"));
}

/**
 * Waits for coc-springboot, then builds the shared state and registers the views.
 */
async function start(context: coc.ExtensionContext): Promise<void> {
    const api = await waitForStsApi();
    if (api === undefined) {
        const inactive: string[] = ["coc-springboot", "coc-java"].filter(id => !coc.extensions.all.find(e => e.id === id)?.isActive);
        coc.window.showWarningMessage(`${inactive.join(", ")} not active`);
    } else {
        const live = new LiveData(api);
        const symbols = new Symbols(api);
        const tabs = new OutputTabs();
        const launcher = new TerminalLauncher(context, tabs);
        const d: Dashboard = { context, api, live, symbols, apps: new AppsView(live, launcher), appTab: new AppTab(), views: new Map() };
        context.subscriptions.push(live, symbols);
        registerApps(d);
        registerBeans(d);
        context.subscriptions.push(coc.commands.registerCommand("spring.staticData.refresh", () => d.symbols.refresh(true), undefined, true));
        registerMappings(d);
        registerProperties(d);
        registerMemory(d);
        await tabs.useViews(context, () => layoutViews(d), name => d.appTab.set(name));
        registerGutter(d);
        registerRemote(d);
        await live.init();
        waitFor("spring").then(() => d.appTab.refresh()).catch(() => undefined);
    }
}
