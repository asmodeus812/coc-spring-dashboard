import * as coc from "coc.nvim";
import { sleep } from "./util";

/**
 * What a debugger needs to attach to a running app: the java-debug adapter of jdtls and the JDWP port of the JVM.
 */
export interface AttachTarget {
    name: string;
    /** The key of the app's dashboard tab: a stop shows its line in the source window of that app. */
    tab: string;
    projectName: string;
    adapterPort: number;
    /** The host of the JVM. */
    host: string;
    jdwpPort: number;
}

/**
 * A debugger front end. The launcher starts the JVM and the adapter, a backend only attaches to them.
 */
export interface DebugBackend {
    readonly name: string;
    available(): Promise<boolean>;
    /** Starts the attach, resolves once the debugger is attached and rejects when it is not within `timeout` ms. */
    attach(target: AttachTarget, timeout: number): Promise<void>;
    /** Whether a debugger is still attached to the target. */
    attached(target: AttachTarget): Promise<boolean>;
}

/**
 * nvim-dap: the adapter is a server on the adapter port, the session is a plain java attach to the JDWP port.
 */
class NvimDapBackend implements DebugBackend {
    public readonly name: string = "nvim-dap";

    public async available(): Promise<boolean> {
        return coc.workspace.isNvim && (await coc.workspace.nvim.lua("return (pcall(require, 'dap'))") as unknown) === true;
    }

    public async attach(target: AttachTarget, timeout: number): Promise<void> {
        const adapter: string = `spring-${target.name}`;
        await coc.workspace.nvim.lua(
            `local adapter, target = ...
            local dap = require('dap')
            dap.adapters[adapter] = { type = 'server', host = '127.0.0.1', port = target.adapterPort }
            -- where a stop shows its line: the source window of the app, only for this adapter
            dap.defaults[adapter].switchbuf = function(bufnr, line, column)
                vim.fn.CocActionAsync('runCommand', 'spring-boot-dashboard.source.open', target.tab, vim.uri_from_bufnr(bufnr), line, column)
            end
            dap.run({ type = adapter, request = 'attach', name = adapter, hostName = target.host, port = target.jdwpPort, projectName = target.projectName })`,
            [adapter, target as any],
        );
        const started: number = Date.now();
        let attached: boolean = await this.attached(target);
        while (!attached && Date.now() - started < timeout) {
            await sleep(500);
            attached = await this.attached(target);
        }
        if (!attached) {
            throw new Error(`debugger not attached within ${Math.round(timeout / 1000)} seconds`);
        }
    }

    public async attached(target: AttachTarget): Promise<boolean> {
        const result = await coc.workspace.nvim.lua(
            `local port = ...
            local session = require('dap').session()
            return session ~= nil and session.config ~= nil and session.config.port == port`,
            [target.jdwpPort],
        );
        return (result as unknown) === true;
    }
}

/**
 * vimspector: an attach configuration with an inline socket adapter, so no .vimspector.json and no gadget are needed.
 * It opens its own debug tab, and a reset or stop only detaches from the JVM.
 */
class VimspectorBackend implements DebugBackend {
    public readonly name: string = "vimspector";
    /** The count of ended debug sessions when the attach started, per JDWP port. */
    private readonly ended: Map<number, number> = new Map();

    public async available(): Promise<boolean> {
        const nvim = coc.workspace.nvim;
        return (await nvim.call("globpath", [await nvim.eval("&runtimepath"), "autoload/vimspector.vim"])) !== ""
            && (await nvim.call("has", ["python3"])) === 1;
    }

    public async attach(target: AttachTarget, _timeout: number): Promise<void> {
        const nvim = coc.workspace.nvim;
        const name: string = `spring-${target.name}`;
        const before: number = await this.endedCount();
        // literal values only, vimspector expands ${...} in both dicts
        await nvim.call("vimspector#LaunchWithConfigurations", [{
            [name]: {
                adapter: { host: "127.0.0.1", port: target.adapterPort },
                configuration: { request: "attach", name, hostName: target.host, port: target.jdwpPort, projectName: target.projectName },
            },
        }]);
        this.ended.set(target.jdwpPort, before);
    }

    /**
     * Attached until the debug session is reset: vimspector only fires `VimspectorDebugEnded` on a full reset, the
     * terminated event of the adapter just clears the frame.
     */
    public async attached(target: AttachTarget): Promise<boolean> {
        const at: number | undefined = this.ended.get(target.jdwpPort);
        return at !== undefined && at === await this.endedCount();
    }

    private async endedCount(): Promise<number> {
        const nvim = coc.workspace.nvim;
        await nvim.command("if !exists('g:spring_dashboard_ended') | let g:spring_dashboard_ended = 0 | execute 'autocmd User VimspectorDebugEnded let g:spring_dashboard_ended += 1' | endif");
        return (await nvim.eval("g:spring_dashboard_ended")) as number;
    }
}

/**
 * The first available debugger, nvim-dap before vimspector, undefined when there is none.
 */
export async function detectBackend(): Promise<DebugBackend | undefined> {
    const backends: DebugBackend[] = [new NvimDapBackend(), new VimspectorBackend()];
    let found: DebugBackend | undefined = undefined;
    for (const backend of backends) {
        if (found === undefined && await backend.available().catch(() => false)) {
            found = backend;
        }
    }
    return found;
}
