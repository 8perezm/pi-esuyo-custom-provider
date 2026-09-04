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

// ── Types ──────────────────────────────────────────────────────────────────

interface ConfigFile {
    /** Ordered list of custom provider registrations. */
    providers?: CustomProviderEntry[];
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
     * Default: false.
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
     * survives new/resume/fork. Default: false (no behavior change).
     */
    sendSessionHeaders?: boolean;

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

/** Fallback model used when no models are defined and fetchModels is off. */
const FALLBACK_MODEL: ProviderModelConfig = {
    id: "default",
    name: "Default Model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256000,
};

/**
 * Reserved session variable, usable in any provider entry's `headers`
 * values (e.g. `"headers": { "x-opencode-session": "$PI_SESSION_ID" }`).
 * Both `$PI_SESSION_ID` and `${PI_SESSION_ID}` forms are recognized.
 * The distinctive name avoids collisions with real environment variables.
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
 * Fetch available models from an OpenAI-compatible `/v1/models` endpoint.
 * Returns a minimal `ProviderModelConfig` for each entry.
 * `contextWindow` / `maxTokens` are intentionally omitted — provider-level
 * defaults are applied later via `applyProviderDefaults`.
 */
async function fetchModelsFromEndpoint(
    baseUrl: string,
    apiKey?: string,
): Promise<ProviderModelConfig[]> {
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
            data?: Array<{
                id: string;
                object?: string;
                created?: number;
                owned_by?: string;
            }>;
        };

        if (!payload.data || !Array.isArray(payload.data)) {
            console.warn(`[custom-providers] Unexpected response format from ${url}`);
            return [];
        }

        return payload.data.map((m) => ({
            id: m.id,
            name: m.id,
            reasoning: false,
            input: ["text"] as ("text")[],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }));
    } catch (err) {
        console.warn(
            `[custom-providers] Could not fetch models from ${baseUrl}:`,
            err instanceof Error ? err.message : err,
        );
        return [];
    }
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
 * Apply provider-level `contextWindow` / `maxTokens` defaults to every model
 * that doesn't define its own values. Model-level settings always win.
 */
function applyProviderDefaults(
    models: ProviderModelConfig[],
    entry: Pick<CustomProviderEntry, "contextWindow" | "maxTokens">,
): ProviderModelConfig[] {
    return models.map((m) => ({
        ...m,
        contextWindow: m.contextWindow ?? entry.contextWindow,
        maxTokens: m.maxTokens ?? entry.maxTokens,
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

    // Register each provider, catching individual failures so one bad entry
    // doesn't prevent the rest from loading.
    // Providers with `sendSessionHeaders: true` are tracked so the
    // per-request hook below only touches flagged providers. Providers whose
    // raw header templates contain `$PI_SESSION_ID` are tracked separately —
    // the variable IS the opt-in, independent of the flag.
    const sessionHeaderProviders = new Set<string>();
    const sessionVarTemplates = new Map<string, Array<{ key: string; template: string }>>();
    for (const entry of config.providers) {
        try {
            await registerSingleProvider(pi, entry);
            if (typeof entry.name === "string" && entry.name) {
                if (entry.sendSessionHeaders === true) {
                    sessionHeaderProviders.add(entry.name);
                }
                const rawHeaders = (entry as CustomProviderEntry).headers;
                if (rawHeaders && typeof rawHeaders === "object") {
                    for (const [key, value] of Object.entries(rawHeaders)) {
                        if (isAuthHeader(key)) continue;
                        if (containsSessionVar(value)) {
                            const list = sessionVarTemplates.get(entry.name) ?? [];
                            list.push({ key, template: value as string });
                            sessionVarTemplates.set(entry.name, list);
                        }
                    }
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
                            // Overwrite unconditionally with the live value:
                            // Pi core resolves `$VAR` in header values from
                            // ENVIRONMENT variables, so it would have expanded
                            // `$PI_SESSION_ID` from env (or to ""); the live
                            // session id must win over env expansion.
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

async function registerSingleProvider(pi: ExtensionAPI, entry: CustomProviderEntry) {
    const {
        name,
        label,
        baseUrl,
        apiKey,
        fetchModels: shouldFetch,
        models: staticModels = [],
        headers,
        compat,
    } = entry;

    if (!name || !baseUrl) {
        console.warn(`[custom-providers] Skipping entry with missing name or baseUrl`);
        return;
    }

    // ── Resolve models ───────────────────────────────────────────────────

    let models: ProviderModelConfig[];

    if (shouldFetch) {
        const discovered = await fetchModelsFromEndpoint(baseUrl, apiKey);
        models = mergeModels(staticModels, discovered);
    } else if (staticModels.length > 0) {
        models = staticModels;
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

    if (headers && Object.keys(headers).length > 0) {
        providerConfig.headers = headers;
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
}
