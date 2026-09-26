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
assert.equal(merged.at(-1)?.id, "claude-opus-5-5");

// Once pi-ai ships it, it is not added twice.
const shipped = withExtraModels([opus5, ...EXTRA_ANTHROPIC_MODELS]);
assert.deepEqual(
	shipped.map((model) => model.id),
	["claude-opus-5", "claude-opus-5-5"],
);

// The registry's own fields (provider, and whatever else it carries) do not leak
// into the registration.
const cleaned = asRegisteredModel({ ...opus5, provider: "anthropic" });
assert.equal("provider" in cleaned, false);
assert.equal(cleaned.id, "claude-opus-5");
assert.equal(cleaned.contextWindow, 1_000_000);

// The new model mirrors Opus 5 where it matters.
const extra = EXTRA_ANTHROPIC_MODELS[0];
assert.equal(extra?.reasoning, true);
assert.equal(extra?.contextWindow, 1_000_000);
assert.equal(extra?.maxTokens, 128_000);

console.log("ok: extra anthopic models");
