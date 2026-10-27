/**
 * Custom OpenAI Providers Extension for Pi.dev
 *
 * Reads a JSON config file (~/.pi/agent/custom-providers.json by default)
 * and registers each entry as an OpenAI-compatible provider in Pi.dev.
 *
 * Config format:
 * ```json
 * {
 *   "providers": [
 *     {
 *       "name": "my-local-llm",
 *       "label": "My Local LLM",
 *       "baseUrl": "http://localhost:11434/v1",
 *       "apiKey": "no-key-needed",
 *       "fetchModels": true,
 *       "contextWindow": 128000,
 *       "maxTokens": 32000,
 *       "models": [
 *         {
 *           "id": "llama3.1:8b",
 *           "name": "Llama 3.1 8B",
 *           "reasoning": false,
 *           "input": ["text"],
 *           "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
 *           "contextWindow": 128000,
 *           "maxTokens": 32000
 *         }
 *       ],
 *       "headers": { "X-Custom-Header": "value" },
 *       "compat": {
 *         "supportsDeveloperRole": false,
 *         "supportsReasoningEffort": false
 *       }
 *     }
 *   ]
 * }
 * ```
 *
 * Environment variable overrides:
 *   PI_CUSTOM_PROVIDERS_CONFIG — path to a different config file
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
    applyModelsDevToDiscoveredPiModel,
    applyModelsDevToStaticPiModel,
    defaultModelsDevOptions,
    findModelsDevMatch,
    loadModelsDevCatalog,
    resolveModelsDevForProvider,
    shouldEnrichModelsDevMatch,
} from "./models-dev.js";
import type {
    ModelsDevCatalogResult,
    ModelsDevGlobalOptions,
    ModelsDevProviderSetting,
} from "./models-dev.js";

// ── Types ──────────────────────────────────────────────────────────────────

interface ConfigFile {
    /** Ordered list of custom provider registrations. */
    providers?: CustomProviderEntry[];
    /**
     * models.dev catalog enrichment defaults (thinking/reasoning levels,
     * input modalities, context limits). Enabled by default; degrades
     * gracefully (bundled snapshot, then gateway-only) when unreachable.
     */
    modelsDev?: ModelsDevGlobalOptions;
}

interface CustomProviderEntry {
    /**
     * Provider identifier (used in `pi.registerProvider(name, ...)`).
     * This is what you'll select in `/model`, e.g. `my-local-llm`.
     */
    name: string;

    /** Optional display label shown in the login/model UI. Falls back to `name`. */
    label?: string;

    /** Base URL of the OpenAI-compatible API endpoint (e.g. `http://localhost:11434/v1`). */
    baseUrl: string;

    /**
     * API key.
     * Supports the same resolution syntax as models.json:
     *   - `$ENV_VAR` / `${ENV_VAR}` — environment variable reference
     *   - `!command` — shell command (stdout is the key)
     *   - Literal string
     */
    apiKey: string;

    /**
     * If true, fetches available models from `{baseUrl}/models`
     * and merges them with any statically defined `models`.
     * Default: true when no static `models` are given, false otherwise.
     * (A bare `name` + `baseUrl` + `apiKey` entry auto-discovers.)
     */
    fetchModels?: boolean;

    /**
     * Statically defined models. When `fetchModels` is also true,
     * these are merged (static models take precedence by id).
     * If neither `models` nor `fetchModels` is provided,
     * a minimal default model entry is created.
     */
    models?: ProviderModelConfig[];

    /**
     * Provider-level default context window (tokens), applied to every model
     * of this provider that doesn't define its own `contextWindow`.
     * Model-level values always win.
     */
    contextWindow?: number;

    /**
     * Provider-level default max output tokens, applied to every model
     * of this provider that doesn't define its own `maxTokens`.
     * Model-level values always win.
     */
    maxTokens?: number;

    /**
     * Additional HTTP headers sent with every request to this provider.
     * Values support the same resolution syntax as apiKey.
     *
     * The reserved `$PI_SESSION_ID` / `${PI_SESSION_ID}` placeholder is
     * substituted per request with the live Pi session id (see below).
     *
     * IMPORTANT: headers whose values contain the session placeholder are
     * STRIPPED before `pi.registerProvider` is called and NEVER passed to
     * Pi core — Pi resolves every provider header as an env-var template
     * (`resolveHeadersOrThrow`) and would throw
     * `Failed to resolve provider "<id>" header "<key>" from environment
     * variable: PI_SESSION_ID` (surfaced as `API key auth failed`).
     * The extension holds these templates back and injects the live id
     * itself in the `before_provider_headers` hook.
     *
     * Note: `x-opencode-session` / `x-opencode-client` are NOT sent from
     * static `headers` per-request — use `sendSessionHeaders` below if the
     * upstream gateway needs the current Pi conversation id.
     * Auth headers (e.g. `Authorization`) are never touched by that flag.
     */
    headers?: Record<string, string>;

    /**
     * Opt-in per-conversation session attribution for this provider.
     * When true, a `before_provider_headers` hook injects the live session id
     * (`x-opencode-session`, plus `x-opencode-client: pi` when unset) on every
     * request made with this provider. The id is read fresh per request, so it
     * survives new/resume/fork. Default: true (opencode-style gateways
     * require `x-opencode-session`; harmless for plain OpenAI servers).
     * Set to `false` to opt out.
     */
    sendSessionHeaders?: boolean;

    /**
     * models.dev enrichment for this provider: `false` disables it,
     * `true` inherits the global `modelsDev` settings, an object can toggle
     * it or pin catalog match ranking to one models.dev provider namespace
     * (e.g. `{ "provider": "openai" }`).
     */
    modelsDev?: ModelsDevProviderSetting;

    /**
     * Provider-level compatibility overrides.
     * These apply to all models unless overridden at the model level.
     */
    compat?: {
        supportsDeveloperRole?: boolean;
        supportsReasoningEffort?: boolean;
        supportsUsageInStreaming?: boolean;
        maxTokensField?: "max_completion_tokens" | "max_tokens";
        requiresToolResultName?: boolean;
        requiresThinkingAsText?: boolean;
        thinkingFormat?: string;
    };
}

// ── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG_PATH = resolve(homedir(), ".pi", "agent", "custom-providers.json");

/**
 * Hard fallback limits for models that neither models.dev nor the provider
 * config supplies (e.g. an unknown gateway id with no `contextWindow` set).
 * Matches Pi's own `models.json` defaults (128k context / 16k max output)
 * so `pi --list-models` never crashes on `undefined` token counts.
 * Provider-level `contextWindow`/`maxTokens` override these; model-level
 * values (catalog, gateway, or static) override everything.
 */
const SAFE_FALLBACK_CONTEXT_WINDOW = 128000;
const SAFE_FALLBACK_MAX_TOKENS = 16384;

/** Fallback model used when no models are defined and fetchModels is off. */
const FALLBACK_MODEL: ProviderModelConfig = {
    id: "default",
    name: "Default Model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: SAFE_FALLBACK_CONTEXT_WINDOW,
    maxTokens: SAFE_FALLBACK_MAX_TOKENS,
};

/**
 * Reserved session variable, usable in any provider entry's `headers`
 * values (e.g. `"headers": { "x-opencode-session": "$PI_SESSION_ID" }`).
 * Both `$PI_SESSION_ID` and `${PI_SESSION_ID}` forms are recognized.
 * The distinctive name avoids collisions with real environment variables.
 *
 * These templates are held back at registration time and never reach Pi
 * core (which would throw trying to resolve them as env vars); the
 * `before_provider_headers` hook substitutes the live id per request.
 */
const SESSION_ID_VAR_BARE = "$PI_SESSION_ID";
const SESSION_ID_VAR_BRACED = "${PI_SESSION_ID}";

/** True when a raw header template opts into per-request session substitution. */
function containsSessionVar(template: unknown): boolean {
    return (
        typeof template === "string" &&
        (template.includes(SESSION_ID_VAR_BRACED) || template.includes(SESSION_ID_VAR_BARE))
    );
}

/** Substitute every `$PI_SESSION_ID` / `${PI_SESSION_ID}` occurrence with the live id. */
function substituteSessionId(template: string, sid: string): string {
    return template.split(SESSION_ID_VAR_BRACED).join(sid).split(SESSION_ID_VAR_BARE).join(sid);
}

/** Auth headers are never written by session logic, even with an explicit placeholder. */
function isAuthHeader(key: unknown): boolean {
    if (typeof key !== "string") return true;
    const lower = key.toLowerCase();
    return lower === "authorization" || lower === "proxy-authorization";
}

// ── Helpers ────────────────────────────────────────────────────────────────

function loadConfig(configPath: string): ConfigFile {
    if (!existsSync(configPath)) {
        console.warn(`[custom-providers] Config not found: ${configPath}`);
        return { providers: [] };
    }

    try {
        const raw = readFileSync(configPath, "utf-8");
        return JSON.parse(raw) as ConfigFile;
    } catch (err) {
        console.error(`[custom-providers] Failed to parse config: ${configPath}`, err);
        return { providers: [] };
    }
}

/**
 * Resolve a config value that may use pi.dev's value syntax:
 *   - `$ENV_VAR` / `${ENV_VAR}` — environment variable
 *   - `!command` — shell command execution
 *   - literal string — returned as-is
 *
 * For the purposes of model discovery we only resolve env vars;
 * shell commands are not executed (they may have side effects).
 * If the value starts with `!` it's returned as-is.
 */
function resolveApiKey(raw: string): string {
    // Shell command — return as-is, pi.dev resolves it at request time
    if (raw.startsWith("!")) return raw;

    // `${ENV_VAR}` form
    const expanded = raw.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
        return process.env[name] ?? "";
    });

    // `$ENV_VAR` form (but not `$$` escape)
    // Only match whole-word env vars, not partials
    if (expanded.startsWith("$") && !expanded.startsWith("$$")) {
        const name = expanded.slice(1);
        const val = process.env[name];
        if (val !== undefined) return val;
    }

    return expanded.replace(/\$\$/g, "$");
}

/**
 * A model entry as advertised by the gateway's `/v1/models` endpoint.
 * Gateways usually return bare IDs; richer (OpenRouter-style) payloads may
 * carry a display name, token limits, or vision support — all preserved here
 * so live endpoint data wins over catalog data on conflict.
 */
interface GatewayDiscoveredModel {
    id: string;
    raw: Record<string, any>;
}

/**
 * Fetch available models from an OpenAI-compatible `/v1/models` endpoint.
 * Returns the raw gateway entries; the caller enriches them with models.dev
 * metadata and shapes them into `ProviderModelConfig`.
 */
async function fetchModelsFromEndpoint(
    baseUrl: string,
    apiKey?: string,
): Promise<GatewayDiscoveredModel[]> {
    try {
        const url = baseUrl.replace(/\/+$/, "") + "/models";

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        };
        if (apiKey) {
            headers["Authorization"] = `Bearer ${resolveApiKey(apiKey)}`;
        }

        const response = await fetch(url, { headers });

        if (!response.ok) {
            console.warn(`[custom-providers] Failed to fetch models from ${url}: ${response.status}`);
            return [];
        }

        const payload = (await response.json()) as {
            data?: Array<Record<string, any>>;
        };

        if (!payload.data || !Array.isArray(payload.data)) {
            console.warn(`[custom-providers] Unexpected response format from ${url}`);
            return [];
        }

        const out: GatewayDiscoveredModel[] = [];
        const seen = new Set<string>();
        for (const m of payload.data) {
            if (!m || typeof m !== "object") continue;
            const id = typeof m.id === "string" ? m.id.trim() : "";
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out.push({ id, raw: m });
        }
        return out;
    } catch (err) {
        console.warn(
            `[custom-providers] Could not fetch models from ${baseUrl}:`,
            err instanceof Error ? err.message : err,
        );
        return [];
    }
}

/** Gateway-advertised limit/metadata fields (OpenRouter-style payloads). */
function readGatewayRawMeta(raw: Record<string, any>): {
    displayName?: string;
    contextLength?: number;
    maxOutput?: number;
    vision?: boolean;
} {
    const meta: { displayName?: string; contextLength?: number; maxOutput?: number; vision?: boolean } = {};
    const name = raw.display_name ?? raw.displayName ?? raw.name;
    if (typeof name === "string" && name.trim() && name.trim() !== raw.id) meta.displayName = name.trim();
    const ctx = raw.context_length ?? raw.contextLength ?? raw.max_context ?? raw.contextWindow;
    if (typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0) meta.contextLength = ctx;
    const out = raw.max_output_tokens ?? raw.maxOutputTokens ?? raw.max_tokens ?? raw.maxTokens;
    if (typeof out === "number" && Number.isFinite(out) && out > 0) meta.maxOutput = out;
    const vision = raw.supports_vision ?? raw.supportsVision ?? raw.supports_image ?? raw.supportsImage;
    if (typeof vision === "boolean") meta.vision = vision;
    return meta;
}

/**
 * Shape a discovered gateway model into a `ProviderModelConfig`, enriched
 * with models.dev metadata (reasoning levels, input types, context limits).
 * Precedence: models.dev < gateway raw (live endpoint wins on conflict).
 */
function buildDiscoveredModelConfig(
    discovered: GatewayDiscoveredModel,
    catalog: ModelsDevCatalogResult | null,
    modelsDevOpts: Required<ModelsDevGlobalOptions>,
    providerPin?: string,
): ProviderModelConfig {
    const { id, raw } = discovered;
    const model: ProviderModelConfig = {
        id,
        name: id,
        reasoning: false,
        input: ["text"] as ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };

    const match = catalog ? findModelsDevMatch(id, catalog, providerPin) : null;
    if (match && shouldEnrichModelsDevMatch(match.entry, modelsDevOpts)) {
        applyModelsDevToDiscoveredPiModel(model as any, match.entry);
    }

    // Live gateway metadata wins over the catalog on conflict.
    const meta = readGatewayRawMeta(raw);
    if (meta.displayName) model.name = meta.displayName;
    if (meta.contextLength !== undefined) model.contextWindow = meta.contextLength;
    if (meta.maxOutput !== undefined) model.maxTokens = meta.maxOutput;
    if (meta.vision !== undefined) {
        model.input = meta.vision ? (["text", "image"] as ["text", "image"]) : (["text"] as ["text"]);
    }

    return model;
}

/**
 * Enrich user-defined static models fill-only: any explicitly configured
 * value wins, the catalog only supplies what the user left undefined.
 */
function enrichStaticModelConfig(
    model: ProviderModelConfig,
    catalog: ModelsDevCatalogResult | null,
    modelsDevOpts: Required<ModelsDevGlobalOptions>,
    providerPin?: string,
): ProviderModelConfig {
    // Image/classifier configs carry different field semantics — leave them alone.
    if (!catalog || model.type === "image" || model.type === "classifier") return model;
    const match = findModelsDevMatch(model.id, catalog, providerPin);
    if (!match || !shouldEnrichModelsDevMatch(match.entry, modelsDevOpts)) return model;
    applyModelsDevToStaticPiModel(model as any, match.entry);
    return model;
}

/** Merge two model arrays: static models override discovered ones by id. */
function mergeModels(
    staticModels: ProviderModelConfig[],
    discoveredModels: ProviderModelConfig[],
): ProviderModelConfig[] {
    const map = new Map<string, ProviderModelConfig>();

    for (const m of discoveredModels) {
        map.set(m.id, m);
    }

    // Static models override discovered ones
    for (const m of staticModels) {
        map.set(m.id, m);
    }

    return [...map.values()];
}

/**
 * Apply provider-level `contextWindow` / `maxTokens` / `compat` defaults to
 * every model. Model-level settings always win (compat merges per-field).
 * Anything still undefined falls back to `SAFE_FALLBACK_*` (Pi's own
 * `models.json` defaults) so models.dev misses never leave Pi with
 * `undefined` limits (which crashes `pi --list-models`). The provider
 * config's `contextWindow`/`maxTokens` are purely optional overrides —
 * catalog/gateway values are used whenever present.
 *
 * NOTE: Pi's legacy `pi.registerProvider` (`applyExtension`) drops
 * provider-level `compat` — only per-model `compat` reaches the stream
 * (`getCompat(model)` reads `model.compat`). Propagating here ensures e.g.
 * `supportsDeveloperRole: false` actually takes effect on discovered models.
 */
function applyProviderDefaults(
    models: ProviderModelConfig[],
    entry: Pick<CustomProviderEntry, "contextWindow" | "maxTokens" | "compat">,
): ProviderModelConfig[] {
    return models.map((m) => ({
        ...m,
        contextWindow: m.contextWindow ?? entry.contextWindow ?? SAFE_FALLBACK_CONTEXT_WINDOW,
        maxTokens: m.maxTokens ?? entry.maxTokens ?? SAFE_FALLBACK_MAX_TOKENS,
        // `supportsDeveloperRole` defaults to false: `system` is accepted
        // everywhere, `developer` breaks strict gateways. Explicit model-
        // or provider-level settings always win.
        compat: {
            supportsDeveloperRole: false,
            ...entry.compat,
            ...(m.compat ?? {}),
        },
    }));
}

// ── Extension Entry Point ──────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
    // Resolve config path
    const configPath =
        process.env["PI_CUSTOM_PROVIDERS_CONFIG"] ?? DEFAULT_CONFIG_PATH;

    const config = loadConfig(configPath);

    if (!config.providers || config.providers.length === 0) {
        console.warn(`[custom-providers] No providers defined in ${configPath}`);
        return;
    }

    const modelsDevOpts = defaultModelsDevOptions(config.modelsDev);

    // Load the models.dev catalog once when at least one provider opts in —
    // shared by discovery + static enrichment for every provider below.
    let modelsDevCatalog: ModelsDevCatalogResult | null = null;
    const anyModelsDevEnabled =
        modelsDevOpts.enabled &&
        config.providers.some(
            (e) => resolveModelsDevForProvider(modelsDevOpts, e.modelsDev).enabled,
        );
    if (anyModelsDevEnabled) {
        modelsDevCatalog = await loadModelsDevCatalog(modelsDevOpts, (msg, extra) =>
            extra !== undefined
                ? console.log(`[custom-providers] ${msg}`, extra)
                : console.log(`[custom-providers] ${msg}`),
        );
        if (!modelsDevCatalog) {
            console.warn(`[custom-providers] models.dev enrichment unavailable, using gateway metadata only`);
        }
    }

    // Register each provider, catching individual failures so one bad entry
    // doesn't prevent the rest from loading.
    // Providers with `sendSessionHeaders: true` are tracked so the
    // per-request hook below only touches flagged providers. Providers whose
    // raw header templates contain `$PI_SESSION_ID` are tracked separately —
    // the variable IS the opt-in, independent of the flag.
    // `registerSingleProvider` partitions session-variable headers out and
    // returns the held-back templates, so Pi core never sees the placeholder.
    const sessionHeaderProviders = new Set<string>();
    const sessionVarTemplates = new Map<string, Array<{ key: string; template: string }>>();
    for (const entry of config.providers) {
        try {
            const heldBack = await registerSingleProvider(pi, entry, {
                catalog: modelsDevCatalog,
                modelsDevOpts,
            });
            if (typeof entry.name === "string" && entry.name) {
                // Default true: opencode-style gateways require
                // `x-opencode-session`; harmless otherwise. Opt out with false.
                if (entry.sendSessionHeaders !== false) {
                    sessionHeaderProviders.add(entry.name);
                }
                if (heldBack.length > 0) {
                    sessionVarTemplates.set(entry.name, heldBack);
                }
            }
        } catch (err) {
            console.error(
                `[custom-providers] Failed to register provider "${entry.name}":`,
                err instanceof Error ? err.message : err,
            );
        }
    }

    // Per-conversation session attribution: flag auto-injection plus
    // `$PI_SESSION_ID` template substitution. Pi core only sends session
    // headers for built-in opencode providers; this hook closes the gap.
    // Runs after core attribution on every request; mutates event.headers
    // in place (return value is ignored by Pi).
    if (sessionHeaderProviders.size > 0 || sessionVarTemplates.size > 0) {
        pi.on("before_provider_headers", (event, ctx) => {
            try {
                const providerId = ctx?.model?.provider;
                if (typeof providerId !== "string" || providerId.length === 0) {
                    return;
                }
                const varEntries = sessionVarTemplates.get(providerId);
                const wantsFlag = sessionHeaderProviders.has(providerId);
                if (!varEntries && !wantsFlag) {
                    return;
                }
                const headers = event?.headers;
                if (!headers || typeof headers !== "object") {
                    return;
                }
                // Read fresh on every call — never cached — so new/resume/fork
                // sessions are always attributed correctly.
                const rawSid = ctx?.sessionManager?.getSessionId?.();
                const sid =
                    typeof rawSid === "string" && rawSid.length > 0 ? rawSid : null;
                const mutable = headers as Record<string, unknown>;
                // 1) `$PI_SESSION_ID` substitution — opt-in independent of the flag.
                if (varEntries) {
                    for (const { key, template } of varEntries) {
                        if (typeof key !== "string" || key.length === 0) continue;
                        if (isAuthHeader(key)) continue;
                        if (sid === null) {
                            // No session: delete the header rather than
                            // leaking the literal placeholder.
                            mutable[key] = null;
                        } else {
                            // Overwrite unconditionally with the live value.
                            // Pi core never saw the placeholder: it was
                            // stripped before registration (Pi would have
                            // thrown resolving `$PI_SESSION_ID` as an env
                            // var), so the hook is the sole source of truth.
                            mutable[key] = substituteSessionId(template, sid);
                        }
                    }
                }
                // 2) Flag auto-injection — unchanged behavior.
                if (wantsFlag) {
                    if (sid === null) {
                        return;
                    }
                    mutable["x-opencode-session"] = sid;
                    mutable["x-opencode-client"] ??= "pi";
                }
            } catch {
                // A hook failure must never break a request.
            }
        });
    }
}

async function registerSingleProvider(
    pi: ExtensionAPI,
    entry: CustomProviderEntry,
    shared: {
        catalog: ModelsDevCatalogResult | null;
        modelsDevOpts: Required<ModelsDevGlobalOptions>;
    },
): Promise<Array<{ key: string; template: string }>> {
    const {
        name,
        label,
        baseUrl,
        apiKey,
        fetchModels: fetchModelsOpt,
        models: staticModels = [],
        headers,
        compat,
    } = entry;
    // Default: auto-discover when no static models are given, otherwise
    // stay static-only unless explicitly opted in. Lets a bare
    // `name` + `baseUrl` + `apiKey` entry just work.
    const shouldFetch = fetchModelsOpt ?? staticModels.length === 0;

    if (!name || !baseUrl) {
        console.warn(`[custom-providers] Skipping entry with missing name or baseUrl`);
        return [];
    }

    const { catalog, modelsDevOpts } = shared;
    const target = resolveModelsDevForProvider(modelsDevOpts, entry.modelsDev);
    const activeCatalog = target.enabled ? catalog : null;

    // ── Resolve models ───────────────────────────────────────────────────

    let models: ProviderModelConfig[];

    if (shouldFetch) {
        const discovered = await fetchModelsFromEndpoint(baseUrl, apiKey);
        const enriched = discovered.map((d) =>
            buildDiscoveredModelConfig(d, activeCatalog, modelsDevOpts, target.provider),
        );
        const enrichedStatic = staticModels.map((m) =>
            enrichStaticModelConfig(m, activeCatalog, modelsDevOpts, target.provider),
        );
        models = mergeModels(enrichedStatic, enriched);
        if (activeCatalog && discovered.length > 0) {
            const known = enriched.filter(
                (m) => m.reasoning || (m.contextWindow ?? 0) > 0 || m.name !== m.id,
            ).length;
            console.log(
                `[custom-providers] models.dev enrichment for "${name}": ${known}/${discovered.length} discovered models matched (${activeCatalog.source})`,
            );
        }
    } else if (staticModels.length > 0) {
        models = staticModels.map((m) =>
            enrichStaticModelConfig(m, activeCatalog, modelsDevOpts, target.provider),
        );
    } else {
        // Neither fetchModels nor static models: provide a fallback
        // (provider-level contextWindow/maxTokens still take precedence here)
        models = [
            {
                ...FALLBACK_MODEL,
                contextWindow: entry.contextWindow ?? FALLBACK_MODEL.contextWindow,
                maxTokens: entry.maxTokens,
            },
        ];
    }

    // Provider-level contextWindow/maxTokens apply to every model that
    // didn't define its own values — model-level settings always win.
    models = applyProviderDefaults(models, entry);

    // ── Build provider config ────────────────────────────────────────────

    const providerConfig: Record<string, unknown> = {
        name: label ?? name,
        baseUrl,
        apiKey,
        api: "openai-completions",
        models,
    };

    const heldBackTemplates: Array<{ key: string; template: string }> = [];

    if (headers && Object.keys(headers).length > 0) {
        // PARTITION headers: session-variable templates are HELD BACK and
        // never passed to Pi core. Pi resolves EVERY provider header as an
        // env-var template at registration/request time and throws
        // `Failed to resolve provider "<id>" header "<key>" from environment
        // variable: PI_SESSION_ID` for the unresolvable `$PI_SESSION_ID`
        // placeholder (wrapped as `API key auth failed`). Only static
        // headers go to Pi; held-back templates are substituted per request
        // by the `before_provider_headers` hook. Auth headers are never
        // held back or touched by session logic.
        const staticHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(headers)) {
            if (!isAuthHeader(key) && containsSessionVar(value)) {
                heldBackTemplates.push({ key, template: value as string });
                continue;
            }
            staticHeaders[key] = value;
        }
        if (Object.keys(staticHeaders).length > 0) {
            providerConfig.headers = staticHeaders;
        }
        // When nothing static remains, `headers` is omitted entirely —
        // Pi's `resolveHeaders` handles undefined fine.
    }

    if (compat && Object.keys(compat).length > 0) {
        providerConfig.compat = compat;
    }

    // ── Register ─────────────────────────────────────────────────────────

    try {
        pi.registerProvider(name, providerConfig as any);
        console.log(
            `[custom-providers] Registered "${name}" → ${baseUrl} (${models.length} model(s))`,
        );
    } catch (err) {
        console.error(`[custom-providers] Failed to register "${name}":`, err);
    }

    return heldBackTemplates;
}
