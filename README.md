# @esuyo/pi-esuyo-custom-provider

Add any OpenAI-compatible provider to Pi.dev — local models, corporate proxies, or custom API gateways. Configure everything in a single JSON file, no coding required.

## Installation

```bash
pi install npm:@esuyo/pi-esuyo-custom-provider
```

## Quick start

Create `~/.pi/agent/custom-providers.json`:

```json
{
  "providers": [
    {
      "name": "ollama",
      "label": "Ollama Local",
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "fetchModels": true
    }
  ]
}
```

Run `/reload` in Pi (or restart it), then open the model picker with `/model` — your provider's models will appear in the list.

## Configuration

### Provider fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | ✅ | Provider ID used in `/model` (e.g. `my-gateway`). |
| `label` | — | Display name shown in the UI. Defaults to `name`. |
| `baseUrl` | ✅ | OpenAI-compatible API endpoint (e.g. `http://localhost:11434/v1`). |
| `apiKey` | ✅ | API key. Supports env vars (`$MY_KEY` / `${MY_KEY}`) and shell commands (`!command`). |
| `fetchModels` | — | Auto-discover models from `{baseUrl}/models`. Default: `false`. |
| `models` | — | Static model definitions (merged with discovered models when `fetchModels: true`). |
| `contextWindow` | — | Provider-level default context window (tokens). Applied to every model unless the model defines its own. |
| `maxTokens` | — | Provider-level default max output tokens. Applied to every model unless the model defines its own. |
| `headers` | — | Extra HTTP headers sent with every request. |
| `sendSessionHeaders` | — | Send per-conversation `x-opencode-session` / `x-opencode-client` headers (see below). Default: `false`. |
| `compat` | — | Provider compatibility flags (see below). |
| `modelsDev` | — | models.dev enrichment for this provider: `false` disables it, `true`/omitted inherits the global `modelsDev` settings, `{ "provider": "openai" }` pins catalog match ranking. |

### models.dev enrichment (thinking levels, input types, context limits)

Gateways usually expose `/models` as bare IDs with no metadata. When enabled
(the default), the extension looks each discovered — and each static-only —
model up in the [models.dev](https://models.dev) catalog and fills in:

| models.dev | Pi model field | Notes |
|---|---|---|
| `reasoning` | `reasoning` | Enables the thinking UI for capable models. |
| `reasoning_options` effort values | `thinkingLevelMap` | Effort levels (e.g. `low`…`max`) map 1:1 onto Pi thinking levels; `none` enables `off`; unlisted levels are `null` (Pi clamps them). No effort info → field omitted (Pi defaults apply). |
| `modalities.input` | `input` | Pi only supports `text`/`image`; other types (`pdf`, `video`, `audio`) are dropped. |
| `limit.context` | `contextWindow` | Model-specific value beats the provider-level default. |
| `limit.output` | `maxTokens` | |
| `cost` (+ context tiers) | `cost` (+ `tiers` as `inputTokensAbove`) | Display/pricing only. |
| `name` | `name` | Only when the gateway gave no display name. |

Precedence: models.dev < live gateway metadata < provider-level
`contextWindow`/`maxTokens` defaults < explicit static model fields. Static
`models:` entries are enriched fill-only — anything you write wins over the
catalog (including `reasoning: false`, which also suppresses the
`thinkingLevelMap`). Entries with a non-chat catalog `type` (e.g.
`embedding`) only enrich factual fields (name/limits/cost), never
`reasoning`/`input`.

`compat` is never auto-set from the catalog: Pi only sends `reasoning_effort`
when the endpoint advertises `supportsReasoningEffort` (auto-detected or
configured by you), so catalog `reasoning: true` alone cannot break endpoints
that don't understand the parameter.

The catalog is fetched once at startup (shared by all providers) and cached
in memory. If the live fetch fails, the bundled `@opencode-ai/models`
snapshot (at most ~24h old) is used; if that is unavailable too, the
extension falls back to gateway-only metadata with a warning.

Global defaults (top-level `modelsDev` object, all optional):

```json
{
  "modelsDev": {
    "enabled": true,
    "baseUrl": "https://models.dev",
    "timeoutMs": 8000,
    "cacheTtlMs": 3600000,
    "modelTypes": "all",
    "excludeDeprecated": false,
    "excludeTypes": ["embedding"],
    "provider": "openai"
  },
  "providers": [...]
}
```

### API key resolution

Same syntax as Pi's `models.json`:

| Syntax | Description |
|--------|-------------|
| `$ENV_VAR` / `${ENV_VAR}` | Read from environment variable |
| `!command` | Execute shell command, stdout is the value |
| `$$` | Literal `$` |
| `$!` | Literal `!` |
| Plain string | Used as-is |

### Model fields

| Field | Default | Description |
|-------|---------|-------------|
| `id` | — | Model identifier sent to the API (required). |
| `name` | `id` | Human-readable label. |
| `reasoning` | `false` | Supports extended thinking. Auto-filled from models.dev when enabled. |
| `thinkingLevelMap` | — | Maps Pi thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) to provider values; `null` marks a level unsupported. Auto-filled from models.dev effort levels; explicit config wins. |
| `input` | `["text"]` | Input types: `["text"]` or `["text", "image"]`. |
| `contextWindow` | — | Max context window in tokens. Falls back to the provider-level `contextWindow`, otherwise Pi.dev decides. |
| `maxTokens` | — | Max output tokens. Falls back to the provider-level `maxTokens`, otherwise Pi.dev decides. |
| `cost` | all zeros | Per-million-token rates `{ input, output, cacheRead, cacheWrite }`. |

### Session headers

Pi only sends `x-opencode-session` for its built-in opencode providers. If your
gateway needs the current conversation id, opt in per provider:

```json
{
  "providers": [
    {
      "name": "gateway",
      "baseUrl": "https://gateway.corp.com/v1",
      "apiKey": "$GATEWAY_API_KEY",
      "sendSessionHeaders": true
    }
  ]
}
```

With `sendSessionHeaders: true`, every request for that provider gets
`x-opencode-session: <live session id>` (read fresh per request, so it survives
new/resume/fork) and `x-opencode-client: pi` when not already set. Auth headers
are never touched. Providers without the flag are unchanged.

Alternatively, map the session id to any header with `$PI_SESSION_ID` (or
`${PI_SESSION_ID}`) in `headers` — presence of the variable is its own opt-in,
independent of the flag. The extension (not Pi) owns this placeholder:

```json
{
  "providers": [
    {
      "name": "gateway",
      "baseUrl": "https://gateway.corp.com/v1",
      "apiKey": "$GATEWAY_API_KEY",
      "headers": { "x-opencode-session": "$PI_SESSION_ID" }
    }
  ]
}
```

Headers containing `$PI_SESSION_ID` are stripped before `pi.registerProvider`
is called and never reach Pi core — Pi resolves every provider header as an
env-var template and would otherwise throw
`Failed to resolve provider "<id>" header "<key>" from environment variable:
PI_SESSION_ID` (surfaced as `API key auth failed`). The extension holds these
templates back and substitutes the live session id per request in the
`before_provider_headers` hook (overwriting unconditionally).

The value is substituted per request with the live session id. With no live session the header
is deleted (`null`), never sent literally. `Authorization` is never touched.

### Compatibility flags

| Flag | When to use |
|------|-------------|
| `supportsDeveloperRole: false` | Servers that don't understand the `developer` role (Ollama, vLLM). |
| `supportsReasoningEffort: false` | Servers that don't support `reasoning_effort`. |
| `supportsUsageInStreaming: false` | Servers lacking streaming usage support. |
| `maxTokensField: "max_tokens"` | Use `max_tokens` instead of `max_completion_tokens`. |
| `requiresToolResultName: true` | When tool results need a `name` field. |

## Examples

### Local model server (Ollama, vLLM, LM Studio)

```json
{
  "providers": [
    {
      "name": "local",
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "fetchModels": true,
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      }
    }
  ]
}
```

### API gateway with static models

```json
{
  "providers": [
    {
      "name": "gateway",
      "label": "Corporate AI Gateway",
      "baseUrl": "https://gateway.corp.com/v1",
      "apiKey": "$GATEWAY_API_KEY",
      "models": [
        {
          "id": "gpt-4o",
          "input": ["text", "image"],
          "contextWindow": 128000,
          "maxTokens": 16384,
          "cost": { "input": 2.5, "output": 10, "cacheRead": 0.5, "cacheWrite": 1.25 }
        }
      ],
      "headers": {
        "X-Corp-Auth": "$CORP_AUTH_TOKEN"
      }
    }
  ]
}
```

### Multiple providers

```json
{
  "providers": [
    {
      "name": "local",
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "fetchModels": true
    },
    {
      "name": "proxy",
      "baseUrl": "https://my-proxy.example.com/v1",
      "apiKey": "$PROXY_KEY",
      "models": [
        { "id": "claude-sonnet-4", "input": ["text", "image"], "contextWindow": 200000 }
      ]
    }
  ]
}
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_CUSTOM_PROVIDERS_CONFIG` | `~/.pi/agent/custom-providers.json` | Custom path to the config file. |

## Updating

```bash
pi update npm:@esuyo/pi-esuyo-custom-provider
```

Or run `/reload` after updating the config file — no reinstall needed for config changes.

