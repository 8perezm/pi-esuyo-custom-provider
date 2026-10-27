// End-to-end test of the pi extension wiring (gateway discovery + models.dev
// enrichment) with a mocked pi object and a local fake gateway. The extension
// source is loaded through jiti — the same loader pi.dev itself uses — so
// `./models-dev.js` specifiers resolve exactly like production.
// Run: npm test
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const md = await jiti.import("../src/models-dev.ts");
const extensionFactory = (await jiti.import("../src/index.ts")).default;

function gptEntry() {
    return {
        id: "gpt-4o",
        name: "GPT-4o",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 128000, output: 16384 },
        cost: { input: 2.5, output: 10, cache_read: 1.25, cache_write: 0.5 },
    };
}

const FAKE_CATALOG = {
    providers: { openai: { models: { "gpt-4o": gptEntry() } } },
    models: {},
    source: "live",
};

// Gateway payload per test (mutable: raw-metadata conflicts are injected here).
let gatewayModels = [{ id: "gpt-4o" }, { id: "unknown-model-zzz" }];

let server;
let gatewayBase;

async function startGateway() {
    server = http.createServer((req, res) => {
        if ((req.url ?? "").endsWith("/models")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ data: gatewayModels }));
            return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    gatewayBase = `http://127.0.0.1:${server.address().port}/v1`;
}

async function runExtension(configJson) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-md-"));
    const configPath = path.join(dir, "custom-providers.json");
    await fs.writeFile(configPath, JSON.stringify(configJson));
    const registered = new Map();
    const pi = {
        registerProvider: (name, cfg) => registered.set(name, cfg),
        on: () => {},
    };
    const prev = process.env.PI_CUSTOM_PROVIDERS_CONFIG;
    process.env.PI_CUSTOM_PROVIDERS_CONFIG = configPath;
    try {
        await extensionFactory(pi);
    } finally {
        if (prev === undefined) delete process.env.PI_CUSTOM_PROVIDERS_CONFIG;
        else process.env.PI_CUSTOM_PROVIDERS_CONFIG = prev;
        await fs.rm(dir, { recursive: true, force: true });
    }
    return registered;
}

describe("pi extension models.dev integration", () => {
    before(async () => {
        await startGateway();
        md.clearModelsDevCache();
        // Warm the (jiti-instance) module cache with the fake catalog under
        // the default key so the extension never touches the network.
        const warmed = await md.loadModelsDevCatalog(md.defaultModelsDevOptions(), undefined, {
            fetchCatalog: async () => structuredClone(FAKE_CATALOG),
        });
        assert.equal(warmed.source, "live");
    });

    after(() => server.close());

    it("enriches discovered models: reasoning, input, limits, cost", async () => {
        gatewayModels = [{ id: "gpt-4o" }, { id: "unknown-model-zzz" }];
        const registered = await runExtension({
            providers: [
                { name: "test-gw", baseUrl: gatewayBase, apiKey: "k", fetchModels: true, contextWindow: 64000 },
            ],
        });
        const cfg = registered.get("test-gw");
        assert.ok(cfg, "provider should be registered");
        assert.equal(cfg.models.length, 2);

        const gpt = cfg.models.find((m) => m.id === "gpt-4o");
        assert.equal(gpt.name, "GPT-4o");
        assert.equal(gpt.reasoning, true);
        assert.deepEqual(gpt.input, ["text", "image"]);
        assert.equal(gpt.contextWindow, 128000); // catalog beats the provider default...
        assert.equal(gpt.maxTokens, 16384);
        assert.equal(gpt.cost.input, 2.5);
        assert.equal(gpt.cost.cacheRead, 1.25);
        assert.equal(gpt.thinkingLevelMap.high, "high");
        assert.equal(gpt.thinkingLevelMap.off, null);

        const unknown = cfg.models.find((m) => m.id === "unknown-model-zzz");
        assert.equal(unknown.reasoning, false); // untouched defaults
        assert.deepEqual(unknown.input, ["text"]);
        assert.equal(unknown.contextWindow, 64000); // ...which still applies without a match
        assert.equal(unknown.thinkingLevelMap, undefined);
    });

    it("live gateway metadata wins over the catalog on conflict", async () => {
        gatewayModels = [{ id: "gpt-4o", context_length: 64000, display_name: "Gateway 4o" }];
        const registered = await runExtension({
            providers: [{ name: "test-gw", baseUrl: gatewayBase, apiKey: "k", fetchModels: true }],
        });
        const gpt = registered.get("test-gw").models.find((m) => m.id === "gpt-4o");
        assert.equal(gpt.contextWindow, 64000);
        assert.equal(gpt.name, "Gateway 4o");
        assert.equal(gpt.reasoning, true); // catalog still fills the gaps
    });

    it("static models are fill-only and modelsDev:false opts out", async () => {
        gatewayModels = [{ id: "gpt-4o" }];
        const registered = await runExtension({
            providers: [
                {
                    name: "static-gw",
                    baseUrl: gatewayBase,
                    apiKey: "k",
                    fetchModels: true,
                    models: [
                        {
                            id: "gpt-4o",
                            name: "Custom Name",
                            reasoning: false,
                            input: ["text"],
                            contextWindow: 777,
                            cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                        },
                    ],
                },
                { name: "plain-gw", baseUrl: gatewayBase, apiKey: "k", fetchModels: true, modelsDev: false },
            ],
        });

        const pinned = registered.get("static-gw").models.find((m) => m.id === "gpt-4o");
        assert.equal(pinned.name, "Custom Name");
        assert.equal(pinned.reasoning, false);
        assert.equal(pinned.contextWindow, 777);
        assert.equal(pinned.cost.input, 1);
        assert.equal(pinned.thinkingLevelMap, undefined);

        const plain = registered.get("plain-gw").models.find((m) => m.id === "gpt-4o");
        assert.equal(plain.name, "gpt-4o");
        assert.equal(plain.reasoning, false);
        // No catalog, no provider defaults → safe fallback (never undefined,
        // otherwise `pi --list-models` crashes).
        assert.equal(plain.contextWindow, 128000);
        assert.equal(plain.maxTokens, 16384);
    });

    it("static-only providers gain catalog limits without discovery", async () => {
        const registered = await runExtension({
            providers: [
                {
                    name: "static-only",
                    baseUrl: gatewayBase,
                    apiKey: "k",
                    models: [{ id: "gpt-4o", name: "GPT-4o", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
                },
            ],
        });
        const gpt = registered.get("static-only").models.find((m) => m.id === "gpt-4o");
        assert.equal(gpt.contextWindow, 128000);
        assert.equal(gpt.maxTokens, 16384);
        assert.equal(gpt.thinkingLevelMap.medium, "medium");
    });
});
