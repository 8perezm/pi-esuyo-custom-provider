/**
 * models.dev enrichment for the Pi Custom Provider extension.
 *
 * models.dev (https://models.dev) publishes a curated catalog of model
 * metadata: thinking/reasoning levels (`reasoning`, `reasoning_options`),
 * supported input/output modalities (`modalities`), and token limits
 * (`limit.context` / `limit.output`), plus cost. Gateway `/v1/models`
 * listings are usually bare IDs, so each discovered (and static-only) model
 * is looked up in the catalog and mapped onto Pi's `ProviderModelConfig`:
 *
 *   reasoning (+ reasoning_options effort values) -> reasoning + thinkingLevelMap
 *     e.g. effort ["low","medium","high","xhigh","max"] maps 1:1 onto Pi's
 *     thinking levels (minimal/low/medium/high/xhigh/max); "none" enables
 *     `off`; levels a model doesn't offer are null (unsupported) so Pi clamps.
 *   modalities.input  -> input (Pi only supports "text"/"image"; anything
 *                        else is dropped, image is kept when present)
 *   limit.context     -> contextWindow
 *   limit.output      -> maxTokens
 *   cost              -> cost (+ tiers as inputTokensAbove tiers)
 *   name              -> name (only when the gateway gave no display name)
 *
 * Safety notes:
 * - `compat` is never auto-set from the catalog. Pi only sends
 *   `reasoning_effort` when the endpoint advertises `supportsReasoningEffort`
 *   (auto-detected or user-configured), so `reasoning: true` alone cannot
 *   break endpoints that don't understand the parameter.
 * - Static `models:` entries are enriched fill-only: any user-defined value
 *   (reasoning, input, contextWindow, maxTokens, cost, thinkingLevelMap,
 *   name) always wins over the catalog.
 * - `type` gating: capability-ish fields (reasoning/input/thinkingLevelMap)
 *   only apply to chat-like entries (`type` absent or "chat"). Factual fields
 *   (name/limits/cost) apply to any matched type.
 *
 * The matching/ranking algorithm mirrors the sibling opencode plugin
 * (`esuyo-opencode-custom-provider/src/models-dev.ts`): exact ID matches win,
 * otherwise the last path segment is compared, and ambiguous suffixes resolve
 * deterministically (pinned provider > lab original > non-deprecated).
 */

// ── Config types ─────────────────────────────────────────────────────────────

export interface ModelsDevGlobalOptions {
    /** Master switch. Default true (silent no-op when the catalog is unreachable). */
    enabled?: boolean;
    /** Catalog base URL. Default "https://models.dev". */
    baseUrl?: string;
    /** Live catalog fetch timeout. Default 8000ms. */
    timeoutMs?: number;
    /** In-memory catalog cache TTL. Default 3600000ms (1h). */
    cacheTtlMs?: number;
    /** "all" fetches specialized types too (?type=all). Default "all". */
    modelTypes?: "all" | "standard";
    /** Skip enrichment for catalog entries flagged deprecated. Default false. */
    excludeDeprecated?: boolean;
    /** Skip enrichment for these models.dev `type` values (e.g. ["embedding"]). */
    excludeTypes?: string[];
    /** Global models.dev provider-namespace pin used for match ranking. */
    provider?: string;
}

export interface ModelsDevProviderOverride {
    enabled?: boolean;
    /** Pin match ranking to one models.dev provider namespace (e.g. "openai"). */
    provider?: string;
}

export type ModelsDevProviderSetting = boolean | ModelsDevProviderOverride | undefined;

export interface ResolvedModelsDevTarget {
    enabled: boolean;
    provider?: string;
}

export function resolveModelsDevForProvider(
    globalOpts: Required<ModelsDevGlobalOptions>,
    setting: ModelsDevProviderSetting,
): ResolvedModelsDevTarget {
    if (setting === false) return { enabled: false };
    if (setting === true || setting === undefined || setting === null) {
        return { enabled: globalOpts.enabled, provider: globalOpts.provider };
    }
    if (typeof setting === "object") {
        const enabled = setting.enabled ?? globalOpts.enabled;
        return { enabled, provider: setting.provider ?? globalOpts.provider };
    }
    return { enabled: globalOpts.enabled, provider: globalOpts.provider };
}

export function defaultModelsDevOptions(raw?: ModelsDevGlobalOptions): Required<ModelsDevGlobalOptions> {
    return {
        enabled: raw?.enabled ?? true,
        baseUrl: (raw?.baseUrl ?? "https://models.dev").replace(/\/+$/, ""),
        timeoutMs: raw?.timeoutMs ?? 8000,
        cacheTtlMs: raw?.cacheTtlMs ?? 3600000,
        modelTypes: raw?.modelTypes ?? "all",
        excludeDeprecated: raw?.excludeDeprecated ?? false,
        excludeTypes: Array.isArray(raw?.excludeTypes) ? [...raw.excludeTypes!] : [],
        provider:
            typeof raw?.provider === "string" && raw.provider.trim() ? raw.provider.trim() : (undefined as any),
    };
}

// ── Normalized catalog entry ─────────────────────────────────────────────────

export interface NormalizedModelsDevModel {
    id: string;
    name?: string;
    /** models.dev `type` (absent for standard chat models). */
    type?: string;
    reasoning: boolean;
    reasoningOptions: Array<Record<string, any>>;
    toolCall: boolean;
    attachment: boolean;
    modalitiesInput: string[];
    modalitiesOutput: string[];
    limitContext?: number;
    limitInput?: number;
    limitOutput?: number;
    hasCost: boolean;
    costInput: number;
    costOutput: number;
    costCacheRead: number;
    costCacheWrite: number;
    costTiers: Array<{
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        inputTokensAbove: number;
    }>;
    family?: string;
    /** Only set for alpha/beta/deprecated (absent means generally available). */
    status?: "alpha" | "beta" | "deprecated";
    /** True when the entry came from models.json (lab metadata, no pricing). */
    fromMetadata: boolean;
    /** True when the entry is a lab original (no canonical_model_id link). */
    labOriginal: boolean;
}

export interface ModelsDevMatch {
    entry: NormalizedModelsDevModel;
    /** models.dev provider namespace the match came from ("" for models.json). */
    providerId: string;
    /** models.dev model key (or canonical id for models.json matches). */
    modelKey: string;
}

export interface ModelsDevCatalogResult {
    providers: Record<string, any>;
    models: Record<string, any>;
    source: "live" | "snapshot";
    generatedAt?: string;
}

function isFiniteNumber(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v);
}

function cleanStringList(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of v) {
        if (typeof item !== "string") continue;
        const t = item.trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
    }
    return out;
}

function normalizeLimit(raw: any): { context?: number; input?: number; output?: number } {
    const out: { context?: number; input?: number; output?: number } = {};
    if (!raw || typeof raw !== "object") return out;
    if (isFiniteNumber(raw.context) && raw.context > 0) out.context = raw.context;
    if (isFiniteNumber(raw.input) && raw.input > 0) out.input = raw.input;
    if (isFiniteNumber(raw.output) && raw.output > 0) out.output = raw.output;
    return out;
}

export function normalizeCatalogModel(model: Record<string, any>, fromMetadata = false): NormalizedModelsDevModel {
    const m = model ?? {};
    const limit = normalizeLimit(m.limit);
    const cost = m.cost && typeof m.cost === "object" ? m.cost : undefined;
    const tiers: NormalizedModelsDevModel["costTiers"] = [];
    if (Array.isArray(cost?.tiers)) {
        for (const t of cost.tiers) {
            const size = t?.tier?.size;
            if (!isFiniteNumber(t?.input) || !isFiniteNumber(t?.output) || !isFiniteNumber(size) || size <= 0)
                continue;
            tiers.push({
                input: t.input,
                output: t.output,
                cacheRead: isFiniteNumber(t.cache_read) ? t.cache_read : 0,
                cacheWrite: isFiniteNumber(t.cache_write) ? t.cache_write : 0,
                inputTokensAbove: size,
            });
        }
    }
    const status = m.status;
    return {
        id: typeof m.id === "string" ? m.id : "",
        name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : undefined,
        type: typeof m.type === "string" && m.type.trim() ? m.type.trim() : undefined,
        reasoning: m.reasoning === true,
        reasoningOptions: Array.isArray(m.reasoning_options)
            ? m.reasoning_options.filter((o) => o && typeof o === "object")
            : [],
        toolCall: m.tool_call === true,
        attachment: m.attachment === true,
        modalitiesInput: cleanStringList(m.modalities?.input),
        modalitiesOutput: cleanStringList(m.modalities?.output),
        limitContext: limit.context,
        limitInput: limit.input,
        limitOutput: limit.output,
        hasCost: !!cost && isFiniteNumber(cost.input) && isFiniteNumber(cost.output),
        costInput: isFiniteNumber(cost?.input) ? cost.input : 0,
        costOutput: isFiniteNumber(cost?.output) ? cost.output : 0,
        costCacheRead: isFiniteNumber(cost?.cache_read) ? cost.cache_read : 0,
        costCacheWrite: isFiniteNumber(cost?.cache_write) ? cost.cache_write : 0,
        costTiers: tiers,
        family: typeof m.family === "string" && m.family.trim() ? m.family.trim() : undefined,
        status: status === "alpha" || status === "beta" || status === "deprecated" ? status : undefined,
        fromMetadata,
        labOriginal: fromMetadata
            ? false
            : !(typeof m.canonical_model_id === "string" && m.canonical_model_id.trim()),
    };
}

// ── Catalog loading (live fetch with snapshot fallback, TTL cached) ──────────

export interface ModelsDevLoaderDeps {
    fetchCatalog?: (request: { signal?: AbortSignal; modelTypes?: "all" }) => Promise<{
        providers: Record<string, any>;
        models: Record<string, any>;
    }>;
    loadSnapshot?: () => Promise<{
        providers: Record<string, any>;
        models: Record<string, any>;
        generatedAt?: string;
    }>;
}

interface CacheEntry {
    catalog: ModelsDevCatalogResult;
    at: number;
}

const catalogCache = new Map<string, CacheEntry>();

export function clearModelsDevCache(): void {
    catalogCache.clear();
}

async function defaultFetchCatalog(
    baseUrl: string,
    modelTypes: "all" | "standard",
    timeoutMs: number,
): Promise<{ providers: Record<string, any>; models: Record<string, any> }> {
    const mod: any = await import("@opencode-ai/models");
    const client = mod.Models.make({ baseUrl });
    const opts: any = { signal: AbortSignal.timeout(timeoutMs) };
    if (modelTypes === "all") opts.modelTypes = "all";
    return await client.catalog(opts);
}

async function defaultLoadSnapshot(): Promise<{
    providers: Record<string, any>;
    models: Record<string, any>;
    generatedAt?: string;
}> {
    const snap: any = await import("@opencode-ai/models/snapshot");
    return {
        providers: snap.providers,
        models: snap.models,
        generatedAt: snap.generatedAt,
    };
}

export async function loadModelsDevCatalog(
    opts: Required<ModelsDevGlobalOptions>,
    log?: (msg: string, extra?: any) => void,
    deps?: ModelsDevLoaderDeps,
): Promise<ModelsDevCatalogResult | null> {
    const cacheKey = `${opts.baseUrl}|${opts.modelTypes}`;
    const now = Date.now();
    const hit = catalogCache.get(cacheKey);
    if (hit && now - hit.at < opts.cacheTtlMs) {
        log?.(`models.dev catalog cache hit (${hit.catalog.source})`);
        return hit.catalog;
    }

    // 1) Live catalog.
    try {
        const catalog = deps?.fetchCatalog
            ? await deps.fetchCatalog({
                  signal: AbortSignal.timeout(opts.timeoutMs),
                  modelTypes: opts.modelTypes === "all" ? "all" : undefined,
              })
            : await defaultFetchCatalog(opts.baseUrl, opts.modelTypes, opts.timeoutMs);
        const result: ModelsDevCatalogResult = {
            providers: catalog?.providers ?? {},
            models: catalog?.models ?? {},
            source: "live",
        };
        if (Object.keys(result.providers).length > 0) {
            catalogCache.set(cacheKey, { catalog: result, at: now });
            log?.(`models.dev catalog loaded (live)`, { providers: Object.keys(result.providers).length });
            return result;
        }
        throw new Error("live catalog is empty");
    } catch (err: any) {
        log?.(`models.dev live catalog unavailable (${err?.message ?? String(err)}), trying snapshot`);
    }

    // 2) Bundled snapshot fallback (ships inside @opencode-ai/models).
    try {
        const snap = deps?.loadSnapshot ? await deps.loadSnapshot() : await defaultLoadSnapshot();
        const result: ModelsDevCatalogResult = {
            providers: snap?.providers ?? {},
            models: snap?.models ?? {},
            source: "snapshot",
            generatedAt: snap?.generatedAt,
        };
        if (Object.keys(result.providers).length > 0) {
            catalogCache.set(cacheKey, { catalog: result, at: now });
            log?.(`models.dev catalog loaded (snapshot fallback)`, {
                providers: Object.keys(result.providers).length,
                generatedAt: result.generatedAt,
            });
            return result;
        }
        throw new Error("snapshot catalog is empty");
    } catch (err: any) {
        log?.(`models.dev snapshot unavailable (${err?.message ?? String(err)}), enrichment disabled`);
    }
    return null;
}

// ── Matching ─────────────────────────────────────────────────────────────────

interface Candidate {
    providerId: string;
    key: string;
    entry: NormalizedModelsDevModel;
    fullLower: string;
    suffixLower: string;
    canonicalLower: string;
    canonicalSuffixLower: string;
}

const indexCache = new WeakMap<ModelsDevCatalogResult, { providerPool: Candidate[]; metaPool: Candidate[] }>();

function lastSegment(v: string): string {
    const i = v.lastIndexOf("/");
    return i === -1 ? v : v.slice(i + 1);
}

function buildIndex(catalog: ModelsDevCatalogResult): {
    providerPool: Candidate[];
    metaPool: Candidate[];
} {
    const cached = indexCache.get(catalog);
    if (cached) return cached;
    const providerPool: Candidate[] = [];
    for (const [providerId, provider] of Object.entries(catalog.providers ?? {})) {
        const models = (provider as any)?.models;
        if (!models || typeof models !== "object") continue;
        for (const [key, model] of Object.entries(models)) {
            if (!model || typeof model !== "object") continue;
            const m = model as unknown as Record<string, any>;
            const canon = typeof m.canonical_model_id === "string" ? m.canonical_model_id.trim() : "";
            const keyTrim = key.trim();
            if (!keyTrim) continue;
            providerPool.push({
                providerId,
                key: keyTrim,
                entry: normalizeCatalogModel(m),
                fullLower: keyTrim.toLowerCase(),
                suffixLower: lastSegment(keyTrim).toLowerCase(),
                canonicalLower: canon.toLowerCase(),
                canonicalSuffixLower: canon ? lastSegment(canon).toLowerCase() : "",
            });
        }
    }
    const metaPool: Candidate[] = [];
    for (const [key, meta] of Object.entries(catalog.models ?? {})) {
        if (!meta || typeof meta !== "object") continue;
        const keyTrim = key.trim();
        if (!keyTrim) continue;
        metaPool.push({
            providerId: "",
            key: keyTrim,
            entry: normalizeCatalogModel(meta as Record<string, any>, true),
            fullLower: keyTrim.toLowerCase(),
            suffixLower: lastSegment(keyTrim).toLowerCase(),
            canonicalLower: "",
            canonicalSuffixLower: "",
        });
    }
    const built = { providerPool, metaPool };
    indexCache.set(catalog, built);
    return built;
}

function normalizeName(v: string): string {
    return v.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * True when a candidate comes from the namespace that owns its canonical
 * model id (`meta/...` for a `meta/muse-spark-1.3` canonical). Those entries
 * carry authoritative capabilities; some reseller mirrors advertise extra
 * reasoning levels (e.g. `max`) the canonical deployment does not support.
 */
function isCanonicalOwner(c: Candidate): boolean {
    const slash = c.canonicalLower.indexOf("/");
    if (slash === -1) return false;
    return normalizeName(c.providerId) === normalizeName(c.canonicalLower.slice(0, slash));
}

function rankCandidates(cands: Array<{ c: Candidate; score: number }>, providerPin?: string): Candidate | null {
    if (cands.length === 0) return null;
    const pin = providerPin?.trim().toLowerCase();
    cands.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (pin) {
            const ap = a.c.providerId.toLowerCase() === pin ? 1 : 0;
            const bp = b.c.providerId.toLowerCase() === pin ? 1 : 0;
            if (bp !== ap) return bp - ap;
        }
        // Canonical owner beats resellers, then unlinked (lab-original) entries.
        const aown = isCanonicalOwner(a.c) ? 1 : 0;
        const bown = isCanonicalOwner(b.c) ? 1 : 0;
        if (bown !== aown) return bown - aown;
        const alab = a.c.entry.labOriginal ? 1 : 0;
        const blab = b.c.entry.labOriginal ? 1 : 0;
        if (blab !== alab) return blab - alab;
        const adep = a.c.entry.status === "deprecated" ? 0 : 1;
        const bdep = b.c.entry.status === "deprecated" ? 0 : 1;
        if (bdep !== adep) return bdep - adep;
        if (a.c.providerId !== b.c.providerId) return a.c.providerId < b.c.providerId ? -1 : 1;
        return a.c.key < b.c.key ? -1 : a.c.key > b.c.key ? 1 : 0;
    });
    return cands[0].c;
}

function searchPool(pool: Candidate[], lower: string, suffix: string): Array<{ c: Candidate; score: number }> {
    const out: Array<{ c: Candidate; score: number }> = [];
    for (const c of pool) {
        if (c.fullLower === lower || (c.canonicalLower && c.canonicalLower === lower)) {
            out.push({ c, score: 3 });
        } else if (c.suffixLower === suffix || (c.canonicalSuffixLower && c.canonicalSuffixLower === suffix)) {
            out.push({ c, score: 1 });
        }
    }
    return out;
}

export function findModelsDevMatch(
    gatewayId: string,
    catalog: ModelsDevCatalogResult | null | undefined,
    providerPin?: string,
): ModelsDevMatch | null {
    if (!catalog) return null;
    const gid = (gatewayId ?? "").trim();
    if (!gid) return null;
    const lower = gid.toLowerCase();
    const suffix = lastSegment(lower);
    if (!suffix || suffix.length < 2) return null;
    const { providerPool, metaPool } = buildIndex(catalog);
    const ranked = rankCandidates(searchPool(providerPool, lower, suffix), providerPin);
    if (ranked) return { entry: ranked.entry, providerId: ranked.providerId, modelKey: ranked.key };
    const metaRanked = rankCandidates(searchPool(metaPool, lower, suffix), providerPin);
    if (metaRanked) return { entry: metaRanked.entry, providerId: "", modelKey: metaRanked.key };
    return null;
}

// ── Gating + Pi mapping ──────────────────────────────────────────────────────

/** False when the entry is opted out via excludeTypes/excludeDeprecated. */
export function shouldEnrichModelsDevMatch(
    entry: NormalizedModelsDevModel,
    opts: Required<ModelsDevGlobalOptions>,
): boolean {
    if (opts.excludeDeprecated && entry.status === "deprecated") return false;
    if (opts.excludeTypes.length > 0 && entry.type) {
        const t = entry.type.toLowerCase();
        if (opts.excludeTypes.some((x) => x.toLowerCase() === t)) return false;
    }
    return true;
}

/** True for standard chat models (models.dev leaves `type` absent for those). */
export function isChatLikeModelsDevModel(entry: NormalizedModelsDevModel): boolean {
    return !entry.type || entry.type.toLowerCase() === "chat";
}

/** Pi thinking levels (including "off"); models.dev effort values map 1:1. */
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type PiThinkingLevelMap = Partial<Record<(typeof PI_THINKING_LEVELS)[number], string | null>>;

/**
 * Build Pi's `thinkingLevelMap` from models.dev `reasoning_options`.
 * Effort values (e.g. ["low","medium","high"]) map onto the same-named Pi
 * levels; "none" enables `off`; unlisted levels are null (Pi clamps them).
 * Returns undefined when the catalog carries no mappable effort info, so Pi
 * falls back to its provider defaults.
 */
export function buildThinkingLevelMap(
    reasoning: boolean,
    reasoningOptions: Array<Record<string, any>>,
): PiThinkingLevelMap | undefined {
    if (!reasoning) return undefined;
    const effort = (reasoningOptions ?? []).find((o) => o && o.type === "effort");
    const values = effort && Array.isArray(effort.values) ? effort.values : [];
    const set = new Set(values.filter((v): v is string => typeof v === "string"));
    if (set.size === 0) return undefined;
    const map: PiThinkingLevelMap = {};
    for (const level of PI_THINKING_LEVELS) {
        if (level === "off") {
            map.off = set.has("none") ? "none" : null;
        } else {
            map[level] = set.has(level) ? level : null;
        }
    }
    const usable = (Object.keys(map) as Array<keyof PiThinkingLevelMap>).some((k) => map[k] !== null);
    return usable ? map : undefined;
}

/** Pi only supports text/image inputs; catalog extras (pdf/video/audio) are dropped. */
export function mapModalitiesToPiInput(modalitiesInput: string[]): ["text"] | ["text", "image"] {
    const lower = modalitiesInput.map((m) => m.toLowerCase());
    return lower.includes("image") ? ["text", "image"] : ["text"];
}

export interface PiCost {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: Array<{
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        inputTokensAbove: number;
    }>;
}

export function mapCostToPi(entry: NormalizedModelsDevModel): PiCost {
    const cost: PiCost = {
        input: entry.costInput,
        output: entry.costOutput,
        cacheRead: entry.costCacheRead,
        cacheWrite: entry.costCacheWrite,
    };
    if (entry.costTiers.length > 0) {
        cost.tiers = entry.costTiers.map((t) => ({
            input: t.input,
            output: t.output,
            cacheRead: t.cacheRead,
            cacheWrite: t.cacheWrite,
            inputTokensAbove: t.inputTokensAbove,
        }));
    }
    return cost;
}

/** Minimal structural view of the Pi chat-model fields this file writes. */
export interface PiChatModelFields {
    id: string;
    name?: string;
    reasoning?: boolean;
    thinkingLevelMap?: PiThinkingLevelMap;
    input?: Array<"text" | "image">;
    contextWindow?: number;
    maxTokens?: number;
    cost?: PiCost;
}

/**
 * Fill a discovered model with catalog metadata (gateway raw values are
 * applied afterwards by the caller so live endpoint data wins on conflict).
 */
export function applyModelsDevToDiscoveredPiModel(
    model: PiChatModelFields,
    entry: NormalizedModelsDevModel,
): void {
    const chatLike = isChatLikeModelsDevModel(entry);
    if (entry.name) model.name = entry.name;
    if (chatLike) {
        model.reasoning = entry.reasoning;
        const tlm = buildThinkingLevelMap(entry.reasoning, entry.reasoningOptions);
        if (tlm) model.thinkingLevelMap = tlm;
        model.input = mapModalitiesToPiInput(entry.modalitiesInput);
    }
    if (entry.limitContext !== undefined) model.contextWindow = entry.limitContext;
    if (entry.limitOutput !== undefined) model.maxTokens = entry.limitOutput;
    if (entry.hasCost) model.cost = mapCostToPi(entry);
}

/**
 * Fill-only enrichment for user-defined static models: only fields the user
 * left undefined are touched, so explicit config always wins.
 */
export function applyModelsDevToStaticPiModel(
    model: PiChatModelFields,
    entry: NormalizedModelsDevModel,
): void {
    const chatLike = isChatLikeModelsDevModel(entry);
    if (model.name === undefined && entry.name) model.name = entry.name;
    if (chatLike) {
        if (model.reasoning === undefined) model.reasoning = entry.reasoning;
        if (model.thinkingLevelMap === undefined) {
            // Use the model's effective reasoning flag (explicit config won
            // above), not the catalog's: reasoning:false must stay map-free.
            const tlm = buildThinkingLevelMap(model.reasoning === true, entry.reasoningOptions);
            if (tlm) model.thinkingLevelMap = tlm;
        }
        if (model.input === undefined) model.input = mapModalitiesToPiInput(entry.modalitiesInput);
    }
    if (model.contextWindow === undefined && entry.limitContext !== undefined)
        model.contextWindow = entry.limitContext;
    if (model.maxTokens === undefined && entry.limitOutput !== undefined) model.maxTokens = entry.limitOutput;
    if (model.cost === undefined && entry.hasCost) model.cost = mapCostToPi(entry);
}
