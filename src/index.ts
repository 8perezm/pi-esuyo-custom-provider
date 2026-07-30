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
     * Additional HTTP headers sent with every request to this provider.
     * Values support the same resolution syntax as apiKey.
     */
    headers?: Record<string, string>;

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
    contextWindow: 128000,
    maxTokens: 4096,
};

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
            contextWindow: 128000,
            maxTokens: 4096,
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
    for (const entry of config.providers) {
        try {
            await registerSingleProvider(pi, entry);
        } catch (err) {
            console.error(
                `[custom-providers] Failed to register provider "${entry.name}":`,
                err instanceof Error ? err.message : err,
            );
        }
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
        models = [FALLBACK_MODEL];
    }

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
