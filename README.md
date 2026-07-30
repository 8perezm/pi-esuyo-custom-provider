# Pi.dev Custom OpenAI Providers Extension

A Pi.dev extension that lets you register custom OpenAI-compatible providers via a JSON config file.

---

## How it works

This extension reads `~/.pi/agent/custom-providers.json` and registers each entry as an OpenAI-compatible provider in Pi.dev using `pi.registerProvider()`. You can define models statically, auto-discover them from the provider's `/v1/models` endpoint, or both.

## Installation

### 1. Install the extension

From this directory, run:

```bash
pi install /home/miguel/REPOS/Esuyo/esuyo-pi-custom-provider
```

Or use a local path symlink for development:

```bash
pi install /home/miguel/REPOS/Esuyo/esuyo-pi-custom-provider -l
```

> **Alternative:** You can also copy the extension to the global extensions folder:
> ```bash
> mkdir -p ~/.pi/agent/extensions/custom-openai-providers
> cp src/index.ts ~/.pi/agent/extensions/custom-openai-providers/index.ts
> ```

### 2. Create your config file

Copy the sample config to the default location:

```bash
cp custom-providers.json ~/.pi/agent/custom-providers.json
```

Then edit it to add your providers (see Configuration below).

### 3. Reload Pi

Run `/reload` inside Pi or restart Pi to pick up the extension.

### 4. Select a model

Open the model picker with `/model` or `Ctrl+P` and choose one of your custom provider's models.

## Configuration

The config file lives at `~/.pi/agent/custom-providers.json` (you can override this with the `PI_CUSTOM_PROVIDERS_CONFIG` environment variable).

### Config format

```json
{
  "providers": [
    {
      "name": "my-provider",
      "label": "My Provider",
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "$MY_API_KEY",
      "fetchModels": false,
      "models": [
        {
          "id": "my-model",
          "name": "My Model",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 128000,
          "maxTokens": 4096
        }
      ],
      "headers": {
        "X-Custom-Header": "value"
      },
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      }
    }
  ]
}
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | ✅ | Provider identifier. Used in `/model` selection (e.g. `my-provider`). |
| `label` | — | Display name shown in the UI. Defaults to `name`. |
| `baseUrl` | ✅ | Base URL of the OpenAI-compatible API endpoint (e.g. `http://localhost:11434/v1`). |
| `apiKey` | ✅ | API key. Supports env var refs (`$MY_KEY` / `${MY_KEY}`) and shell commands (`!command`). |
| `fetchModels` | — | If `true`, fetches models from `{baseUrl}/models` automatically. Default: `false`. |
| `models` | — | Static model definitions. Merged with discovered models when `fetchModels: true`. |
| `headers` | — | Additional HTTP headers. Values use the same resolution syntax as `apiKey`. |
| `compat` | — | Provider-level compatibility flags (see below). |

### API Key resolution

The `apiKey` and header values support the same syntax as Pi's `models.json`:

- `$ENV_VAR` / `${ENV_VAR}` — read from environment variable
- `!command` — execute shell command, stdout is the value
- `$$` — literal `$`
- `$!` — literal `!`
- Plain string — used as-is

### Model field reference

Each model entry supports these fields (most have sensible defaults):

| Field | Default | Description |
|-------|---------|-------------|
| `id` | — | Model identifier passed to the API (required). |
| `name` | `id` | Human-readable label. |
| `reasoning` | `false` | Whether the model supports extended thinking. |
| `input` | `["text"]` | Input modalities: `["text"]` or `["text", "image"]`. |
| `contextWindow` | `128000` | Context window size in tokens. |
| `maxTokens` | `4096` | Maximum output tokens. |
| `cost` | all zeros | Per-million-token rates `{ input, output, cacheRead, cacheWrite }`. |

### Compatibility flags

| Flag | Description |
|------|-------------|
| `supportsDeveloperRole` | Set `false` for servers that don't understand the `developer` role (e.g. Ollama, vLLM). |
| `supportsReasoningEffort` | Set `false` if the server doesn't support `reasoning_effort`. |
| `supportsUsageInStreaming` | Set `false` if the server doesn't support `stream_options: { include_usage: true }`. |
| `maxTokensField` | Use `"max_tokens"` instead of `"max_completion_tokens"`. |
| `requiresToolResultName` | Set `true` if tool results need a `name` field. |

### Fetch models automatically

To auto-discover models from the endpoint, set `fetchModels: true`:

```json
{
  "name": "ollama",
  "baseUrl": "http://localhost:11434/v1",
  "apiKey": "ollama",
  "fetchModels": true
}
```

The extension will call `{baseUrl}/models` and register all returned models. You can also provide static models alongside — they will be merged, with static models taking precedence by ID.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_CUSTOM_PROVIDERS_CONFIG` | `~/.pi/agent/custom-providers.json` | Path to the config file. |

## Examples

### Ollama / LM Studio

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

### Corporate proxy with static models

```json
{
  "providers": [
    {
      "name": "corp-gateway",
      "label": "Corp AI Gateway",
      "baseUrl": "https://gateway.corp.com/v1",
      "apiKey": "$GATEWAY_API_KEY",
      "models": [
        {
          "id": "claude-sonnet-4",
          "name": "Claude Sonnet 4 (Proxy)",
          "reasoning": false,
          "input": ["text", "image"],
          "cost": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 },
          "contextWindow": 200000,
          "maxTokens": 8192
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
        { "id": "gpt-4o-mini", "input": ["text"], "contextWindow": 128000 }
      ]
    }
  ]
}
```

## How it works

1. On startup, Pi loads this extension from `~/.pi/agent/extensions/`
2. The extension reads your JSON config file
3. For each provider entry, it calls `pi.registerProvider()` with your configuration
4. The providers become available in `/model` and `--list-models` immediately

## Development

To test the extension without installing:

```bash
pi -e ./src/index.ts --list-models
```

Make changes to `src/index.ts` or to `custom-providers.json`, then run `/reload` inside Pi.

## Publishing to the Pi.dev Package Gallery

Packages tagged with the `pi-package` keyword on npm are automatically listed at [pi.dev/packages](https://pi.dev/packages).

### Prerequisites

- An [npm account](https://www.npmjs.com/signup)
- Logged in locally: `npm login`

### Steps

1. **Review `package.json`** — ensure the `name`, `repository`, and `keywords` are correct. The `pi-package` keyword is required for gallery listing.

2. **Add gallery metadata** (optional but recommended):
   - Add an `image` or `video` URL under `pi` in `package.json` for a gallery preview:
     ```json
     "pi": {
       "extensions": ["./src/index.ts"],
       "image": "https://example.com/screenshot.png"
     }
     ```

3. **Create a `docs/` folder** with a screenshot if you set the `image` field above.

4. **Publish to npm**:
   ```bash
   npm publish
     ```

5. **Verify** — your package appears at `https://pi.dev/packages/<name>` within minutes. You can also search for it directly.

### Updating

After making changes, bump the version and publish again:

```bash
npm version patch   # or minor, or major
npm publish
```

The gallery updates automatically from npm's registry.

### Installing from the gallery

Users install your package with:

```bash
pi install npm:esuyo-pi-custom-provider
```
