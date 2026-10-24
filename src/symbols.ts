import * as coc from "coc.nvim";
import { StsApi } from "./sts";

/**
 * The location with its uri in the form coc gives its documents, the server sends java style `file:/path` uris.
 */
function normalized(location: coc.Location): coc.Location {
    return { uri: coc.Uri.parse(location.uri).toString(), range: location.range };
}

/**
 * A bean defined in the source, from the `@+` workspace symbols of the spring boot language server.
 */
export class StaticBean {
    public readonly id: string;
    public readonly location: coc.Location;

    constructor(location: coc.Location, name: string) {
        this.location = normalized(location);
        this.id = name.match(/^@\+ '(.+?)'/)?.[1] ?? "unknown";
    }
}

/**
 * The label of a request mapping, the pattern with its method when it has one.
 */
export function endpointLabel(pattern: string, method?: string): string {
    return method ? `${pattern} [${method}]` : pattern;
}

/**
 * A request mapping defined in the source, from the `@/` workspace symbols: `@/path -- GET`.
 */
export class StaticEndpoint {
    public readonly pattern: string;
    public readonly method?: string;
    public readonly location: coc.Location;

    constructor(location: coc.Location, name: string) {
        this.location = normalized(location);
        const [pattern, method] = name.replace(/^@/, "").split(" -- ");
        this.pattern = pattern;
        this.method = method;
    }

    public get label(): string {
        return endpointLabel(this.pattern, this.method);
    }
}

/**
 * The static beans and request mappings of the workspace. Loaded once the spring boot language server is ready and
 * reloaded on every spring index update, the server builds its index after it starts, so the first load can be empty.
 */
export class Symbols implements coc.Disposable {
    public beans: StaticBean[] = [];
    public mappings: StaticEndpoint[] = [];
    private readonly emitter = new coc.Emitter<void>();
    public readonly onDidChange: coc.Event<void> = this.emitter.event;
    private readonly disposables: coc.Disposable[] = [];
    private queue: Promise<void> = Promise.resolve();
    private timer: NodeJS.Timeout | undefined = undefined;
    private retries: number = 0;
    private emptyRetries: number = 0;
    private updated: boolean = false;
    private disposed: boolean = false;

    constructor(private readonly api: StsApi) {
        const index = api.getSpringIndex?.();
        if (index?.onSpringIndexUpdated) {
            this.disposables.push(index.onSpringIndexUpdated((details: { affectedProjects?: string[] } | undefined) => this.onIndexUpdated(details)));
        }
        this.disposables.push(coc.workspace.onDidSaveTextDocument(() => this.refresh()));
        api.client.onReady().then(() => this.loadWhenReady()).catch(() => undefined);
    }

    /**
     * Reloads the symbols, the refreshes run one after the other so the last one always wins.
     */
    public refresh(): Promise<void> {
        this.queue = this.queue.then(() => this.load()).catch(() => undefined);
        return this.queue;
    }

    public under<T extends { location: coc.Location }>(symbols: T[], root: string): T[] {
        return symbols.filter(s => coc.Uri.parse(s.location.uri).fsPath.startsWith(root));
    }

    public dispose(): void {
        this.disposed = true;
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
        }
        this.disposables.forEach(d => d.dispose());
        this.emitter.dispose();
    }

    private onIndexUpdated(details: { affectedProjects?: string[] } | undefined): void {
        this.updated = true;
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
        }
        this.refreshIn((details?.affectedProjects?.length ?? 0) > 0 ? 200 : 500);
    }

    private refreshIn(ms: number): void {
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.refresh();
        }, ms);
    }

    /**
     * The first load, retried a bounded number of times while the server returns nothing and no index update came in.
     */
    private async loadWhenReady(): Promise<void> {
        await this.refresh();
        if (!this.disposed && !this.updated && this.beans.length === 0 && this.mappings.length === 0 && this.retries < 40) {
            this.retries++;
            this.timer = setTimeout(() => {
                this.timer = undefined;
                this.loadWhenReady().catch(() => undefined);
            }, 3000);
        }
    }

    /**
     * A failed request keeps the previous list, and an empty answer that would drop every symbol is retried a few times
     * first: the server answers empty or fails while it rebuilds its index.
     */
    private async load(): Promise<void> {
        if (!this.disposed) {
            const request = (query: string) => this.api.client.sendRequest<coc.SymbolInformation[]>("workspace/symbol", { query }).then(r => r ?? [], () => undefined);
            const [beans, mappings] = await Promise.all([request("@+"), request("@/")]);
            const nextBeans: StaticBean[] = beans === undefined ? this.beans : beans.filter(s => s.name.startsWith("@+")).map(s => new StaticBean(s.location, s.name));
            const nextMappings: StaticEndpoint[] = mappings === undefined ? this.mappings : mappings.filter(s => s.name.startsWith("@/")).map(s => new StaticEndpoint(s.location, s.name));
            const lost: boolean = nextBeans.length + nextMappings.length === 0 && this.beans.length + this.mappings.length > 0;
            if (lost && this.emptyRetries < 3) {
                this.emptyRetries++;
                this.refreshIn(2000);
            } else {
                this.emptyRetries = 0;
                this.beans = nextBeans;
                this.mappings = nextMappings;
                this.emitter.fire();
            }
        }
    }
}
