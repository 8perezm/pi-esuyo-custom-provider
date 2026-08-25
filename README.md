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
| `compat` | — | Provider compatibility flags (see below). |

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
| `reasoning` | `false` | Supports extended thinking. |
| `input` | `["text"]` | Input types: `["text"]` or `["text", "image"]`. |
| `contextWindow` | — | Max context window in tokens. Falls back to the provider-level `contextWindow`, otherwise Pi.dev decides. |
| `maxTokens` | — | Max output tokens. Falls back to the provider-level `maxTokens`, otherwise Pi.dev decides. |
| `cost` | all zeros | Per-million-token rates `{ input, output, cacheRead, cacheWrite }`. |

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

