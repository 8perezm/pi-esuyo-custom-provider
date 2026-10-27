// Unit tests for src/models-dev.ts (pi extension).
// The .ts source is imported directly (Node 22+ type stripping erases the
// type-only syntax; models-dev.ts has no static relative imports).
// Run: npm test
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    applyModelsDevToDiscoveredPiModel,
    applyModelsDevToStaticPiModel,
    buildThinkingLevelMap,
    clearModelsDevCache,
    defaultModelsDevOptions,
    findModelsDevMatch,
    loadModelsDevCatalog,
    mapCostToPi,
    mapModalitiesToPiInput,
    normalizeCatalogModel,
    resolveModelsDevForProvider,
    shouldEnrichModelsDevMatch,
} from "../src/models-dev.ts";

function gptEntry(overrides = {}) {
    return {
        id: "gpt-4o",
        name: "GPT-4o",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 128000, output: 16384 },
        cost: {
            input: 2.5,
            output: 10,
            cache_read: 1.25,
            cache_write: 0.5,
            tiers: [{ input: 5, output: 20, cache_read: 2.5, tier: { type: "context", size: 200000 } }],
        },
        ...overrides,
    };
}

describe("normalizeCatalogModel", () => {
    it("normalizes a full entry", () => {
        const e = normalizeCatalogModel(gptEntry());
        assert.equal(e.reasoning, true);
        assert.equal(e.toolCall, true);
        assert.deepEqual(e.modalitiesInput, ["text", "image"]);
        assert.equal(e.limitContext, 128000);
        assert.equal(e.hasCost, true);
        assert.equal(e.costCacheWrite, 0.5);
        assert.equal(e.costTiers.length, 1);
        assert.equal(e.labOriginal, true);
    });

    it("drops invalid tiers and non-finite numbers", () => {
        const e = normalizeCatalogModel({ id: "x", cost: { input: 1, output: 2, tiers: [{ input: 1 }] } });
        assert.deepEqual(e.costTiers, []);
    });
});

describe("findModelsDevMatch", () => {
    const catalog = {
        providers: { openai: { models: { "gpt-4o": gptEntry() } } },
        models: {},
        source: "live",
    };

    it("matches bare and namespaced gateway ids", () => {
        assert.equal(findModelsDevMatch("gpt-4o", catalog).modelKey, "gpt-4o");
        assert.equal(findModelsDevMatch("my-proxy/gpt-4o", catalog).providerId, "openai");
        assert.equal(findModelsDevMatch("GPT-4O", catalog).providerId, "openai");
    });

    it("prefers the canonical owner over reseller mirrors that add extra levels", () => {
        const catalog = {
            providers: {
                kilo: {
                    models: {
                        "meta/muse-spark-1.3-contributor": {
                            id: "meta/muse-spark-1.3-contributor",
                            reasoning: true,
                            reasoning_options: [
                                { type: "effort", values: ["minimal", "low", "medium", "high", "xhigh", "max"] },
                            ],
                        },
                    },
                },
                meta: {
                    models: {
                        "muse-spark-1.3-contributor": {
                            id: "muse-spark-1.3-contributor",
                            canonical_model_id: "meta/muse-spark-1.3",
                            reasoning: true,
                            reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] }],
                        },
                    },
                },
            },
            models: {},
            source: "live",
        };
        const m = findModelsDevMatch("esuyo/opencode/muse-spark-1.3-contributor", catalog);
        assert.ok(m);
        assert.equal(m.providerId, "meta");
        const map = buildThinkingLevelMap(true, m.entry.reasoningOptions);
        assert.equal(map.max, null); // max not offered by the canonical deployment
        assert.equal(map.xhigh, "xhigh");
        // Explicit pin still wins.
        assert.equal(findModelsDevMatch("esuyo/opencode/muse-spark-1.3-contributor", catalog, "kilo").providerId, "kilo");
    });

    it("returns null for unknown ids", () => {
        assert.equal(findModelsDevMatch("nope-not-a-model", catalog), null);
    });
});

describe("buildThinkingLevelMap", () => {
    it("maps effort values 1:1 onto pi levels, unsupported levels null", () => {
        const map = buildThinkingLevelMap(true, [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }]);
        assert.deepEqual(map, {
            off: null,
            minimal: null,
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
            max: "max",
        });
    });

    it("maps 'none' onto off", () => {
        const map = buildThinkingLevelMap(true, [{ type: "effort", values: ["none", "low", "medium", "high"] }]);
        assert.equal(map.off, "none");
        assert.equal(map.max, null);
    });

    it("returns undefined without usable effort info", () => {
        assert.equal(buildThinkingLevelMap(false, []), undefined);
        assert.equal(buildThinkingLevelMap(true, []), undefined);
        assert.equal(buildThinkingLevelMap(true, [{ type: "toggle" }]), undefined);
        assert.equal(buildThinkingLevelMap(true, [{ type: "effort", values: [] }]), undefined);
    });
});

describe("modality and cost mapping", () => {
    it("keeps image, drops pdf/video/audio", () => {
        assert.deepEqual(mapModalitiesToPiInput(["text", "image", "pdf", "video", "audio"]), ["text", "image"]);
        assert.deepEqual(mapModalitiesToPiInput(["text", "pdf"]), ["text"]);
        assert.deepEqual(mapModalitiesToPiInput([]), ["text"]);
    });

    it("maps cost with tiers", () => {
        const cost = mapCostToPi(normalizeCatalogModel(gptEntry()));
        assert.deepEqual(cost, {
            input: 2.5,
            output: 10,
            cacheRead: 1.25,
            cacheWrite: 0.5,
            tiers: [{ input: 5, output: 20, cacheRead: 2.5, cacheWrite: 0, inputTokensAbove: 200000 }],
        });
    });
});

describe("discovered vs static enrichment", () => {
    const opts = defaultModelsDevOptions();
    const entry = normalizeCatalogModel(gptEntry());

    it("discovered models take catalog values wholesale", () => {
        const model = {
            id: "gpt-4o",
            name: "gpt-4o",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
        applyModelsDevToDiscoveredPiModel(model, entry);
        assert.equal(model.name, "GPT-4o");
        assert.equal(model.reasoning, true);
        assert.deepEqual(model.input, ["text", "image"]);
        assert.equal(model.contextWindow, 128000);
        assert.equal(model.maxTokens, 16384);
        assert.equal(model.cost.input, 2.5);
        assert.equal(model.thinkingLevelMap.max, "max");
    });

    it("static models are fill-only: explicit config always wins", () => {
        const model = {
            id: "gpt-4o",
            name: "Custom Name",
            reasoning: false,
            input: ["text"],
            contextWindow: 777,
            maxTokens: 888,
            cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        };
        applyModelsDevToStaticPiModel(model, entry);
        assert.equal(model.name, "Custom Name");
        assert.equal(model.reasoning, false);
        assert.equal(model.thinkingLevelMap, undefined); // reasoning false -> no map
        assert.deepEqual(model.input, ["text"]);
        assert.equal(model.contextWindow, 777);
        assert.equal(model.cost.input, 1);
    });

    it("static models gain catalog values for undefined fields only", () => {
        const model = { id: "gpt-4o" };
        applyModelsDevToStaticPiModel(model, entry);
        assert.equal(model.name, "GPT-4o");
        assert.equal(model.reasoning, true);
        assert.equal(model.thinkingLevelMap.low, "low");
        assert.equal(model.contextWindow, 128000);
    });

    it("shouldEnrichModelsDevMatch gating", () => {
        assert.equal(shouldEnrichModelsDevMatch(entry, opts), true);
        const o2 = defaultModelsDevOptions({ excludeTypes: ["embedding"] });
        const emb = normalizeCatalogModel({ id: "e", type: "embedding" });
        assert.equal(shouldEnrichModelsDevMatch(emb, o2), false);
    });
});

describe("resolveModelsDevForProvider", () => {
    it("resolves enabled/provider with global fallback", () => {
        const o = defaultModelsDevOptions();
        assert.equal(resolveModelsDevForProvider(o, undefined).enabled, true);
        assert.equal(resolveModelsDevForProvider(o, false).enabled, false);
        assert.equal(resolveModelsDevForProvider(o, { provider: "openai" }).provider, "openai");
    });
});

describe("loadModelsDevCatalog", () => {
    beforeEach(() => clearModelsDevCache());

    it("caches live results", async () => {
        let calls = 0;
        const deps = {
            fetchCatalog: async () => {
                calls++;
                return { providers: { a: { models: {} } }, models: {} };
            },
        };
        const opts = defaultModelsDevOptions();
        assert.equal((await loadModelsDevCatalog(opts, undefined, deps)).source, "live");
        assert.equal((await loadModelsDevCatalog(opts, undefined, deps)).source, "live");
        assert.equal(calls, 1);
    });

    it("falls back to snapshot, then null", async () => {
        const snapDeps = {
            fetchCatalog: async () => {
                throw new Error("offline");
            },
            loadSnapshot: async () => ({ providers: { a: { models: {} } }, models: {} }),
        };
        assert.equal((await loadModelsDevCatalog(defaultModelsDevOptions(), undefined, snapDeps)).source, "snapshot");
        clearModelsDevCache();
        const nullDeps = {
            fetchCatalog: async () => {
                throw new Error("offline");
            },
            loadSnapshot: async () => {
                throw new Error("no pkg");
            },
        };
        assert.equal(await loadModelsDevCatalog(defaultModelsDevOptions(), undefined, nullDeps), null);
    });
});
