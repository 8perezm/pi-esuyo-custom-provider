# Development

## Project structure

```
├── src/
│   └── index.ts          # Extension entry point
├── .github/workflows/
│   └── publish.yml        # GitHub Actions — publishes to npm
├── custom-providers.json  # Example config file
├── package.json           # Package manifest
└── README.md              # User-facing docs
```

## How it works

On startup, Pi loads the extension from `~/.pi/agent/extensions/`. The extension reads a JSON config file (`~/.pi/agent/custom-providers.json` by default) and for each entry calls `pi.registerProvider()` with your configuration. The providers become available in `/model` and `--list-models` immediately.

The config path can be overridden with the `PI_CUSTOM_PROVIDERS_CONFIG` environment variable.

## Testing locally

Without installing:

```bash
pi -e ./src/index.ts --list-models
```

After changes to `src/index.ts` or `custom-providers.json`:

```bash
pi install .
```

Or run `/reload` inside Pi.

## Publishing to npm

This package is published to npm via GitHub Actions. Publishing is triggered by pushing to `main` or `master`, or manually via `workflow_dispatch`.

### Prerequisites

- npm account with access to the `@esuyo` org
- Trusted Publishing set up on npm for this repo (see npm's org settings)

### Release flow

1. Make your changes
2. Commit with a [conventional commit](https://www.conventionalcommits.org/) message:
   - `feat:` — minor version bump
   - `fix:` — patch version bump
   - `BREAKING CHANGE:` — major version bump
3. Push to `main` — the workflow builds, bumps the version, tags, publishes, and creates a GitHub release

Manual publish from CLI:

```bash
npm version patch   # or minor, or major
npm publish --access public
```

## Updating the pi.dev gallery

Gallery updates are automatic — the gallery at [pi.dev/packages](https://pi.dev/packages) scans npm for packages tagged with `pi-package`. No additional steps needed after publishing.
