import assert from "node:assert/strict";
import { EXTRA_ANTHROPIC_MODELS, asRegisteredModel, withExtraModels } from "../src/models.ts";

const opus5 = {
	id: "claude-opus-5",
	name: "Claude Opus 5",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"] as ("text" | "image")[],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};

// The whole catalogue must survive: registering `models` on a built-in provider
// replaces its list, so a registration carrying only the new model would hide
// sonnet, haiku and everything else from the picker.
const merged = withExtraModels([opus5]);
assert.equal(merged.length, 1 + EXTRA_ANTHROPIC_MODELS.length);
assert.equal(merged[0]?.id, "claude-opus-5");
assert.deepEqual(
	merged.slice(-EXTRA_ANTHROPIC_MODELS.length).map((model) => model.id),
	["claude-fable-5-2", "claude-opus-5-5"],
	"the extras keep their order, newest top model first",
);

// Once pi-ai ships it, it is not added twice.
const shipped = withExtraModels([opus5, ...EXTRA_ANTHROPIC_MODELS]);
assert.deepEqual(
	shipped.map((model) => model.id),
	["claude-opus-5", "claude-fable-5-2", "claude-opus-5-5"],
);

// The registry's own fields (provider, and whatever else it carries) do not leak
// into the registration.
const cleaned = asRegisteredModel({ ...opus5, provider: "anthropic" });
assert.equal("provider" in cleaned, false);
assert.equal(cleaned.id, "claude-opus-5");
assert.equal(cleaned.contextWindow, 1_000_000);

// Both extras mirror the model they were cloned from (see src/models.ts:38-41) —
// and nothing about the canonical shape may drift either way.
for (const model of EXTRA_ANTHROPIC_MODELS) {
	for (const field of ["reasoning", "contextWindow", "maxTokens", "input", "api", "baseUrl"] as const) {
		assert.deepEqual(model[field], opus5[field], `${model.id} mirrors claude-opus-5.${field}`);
	}
	assert.equal(model.thinkingLevelMap?.off, null, `${model.id} cannot turn thinking off`);
	assert.equal((model.compat as { forceAdaptiveThinking?: boolean }).forceAdaptiveThinking, true, `${model.id} forces adaptive thinking`);
}
assert.equal(opus5.contextWindow, 1_000_000, "fixture still the shipped 1M window");
assert.equal(opus5.maxTokens, 128_000, "fixture still the shipped 128k output");

// Fable 5.2 is priced at 8/40 with 0.20 cache reads (Anthropic's launch post).
const fable = EXTRA_ANTHROPIC_MODELS.find((model) => model.id === "claude-fable-5-2");
assert.deepEqual(fable?.cost, { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 });
assert.equal(EXTRA_ANTHROPIC_MODELS[0]?.id, "claude-fable-5-2", "and it leads the list");

console.log("ok: extra anthopic models");
