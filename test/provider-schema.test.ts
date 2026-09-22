import assert from "node:assert/strict";
import test from "node:test";
import { stripRefusedBounds, stripRefusedBoundsInMessages } from "../src/provider-schema.ts";

/**
 * Anthropic rejects `minimum`/`maximum` on an integer property, and one such
 * property anywhere in the tool list fails the whole request. The pool's stream
 * wrapper strips them for every request it carries.
 */
test("strips the bounds Anthropic refuses, in place and at every level", () => {
	const schema = {
		type: "object",
		required: ["limit"],
		properties: {
			limit: { type: "integer", minimum: 1, maximum: 50, description: "how many" },
			rows: { type: "array", items: { type: "integer", minimum: 0 } },
			pick: { anyOf: [{ type: "integer", maximum: 3 }, { type: "string" }] },
			nested: { type: "object", properties: { deep: { type: "integer", minimum: 2 } } },
		},
	};
	const heldByTheRequest = schema;

	assert.equal(stripRefusedBounds(schema), 5);
	assert.equal(heldByTheRequest, schema);
	assert.deepEqual(schema, {
		type: "object",
		required: ["limit"],
		properties: {
			limit: { type: "integer", description: "how many" },
			rows: { type: "array", items: { type: "integer" } },
			pick: { anyOf: [{ type: "integer" }, { type: "string" }] },
			nested: { type: "object", properties: { deep: { type: "integer" } } },
		},
	});
});

test("keeps bounds on a number, where Anthropic accepts them", () => {
	const schema = { type: "number", minimum: 0, maximum: 1 };
	assert.equal(stripRefusedBounds(schema), 0);
	assert.deepEqual(schema, { type: "number", minimum: 0, maximum: 1 });
});

test("does not confuse a parameter named minimum with the keyword", () => {
	const schema = { type: "object", properties: { minimum: { type: "integer", minimum: 0 } } };
	stripRefusedBounds(schema);
	assert.deepEqual(schema, { type: "object", properties: { minimum: { type: "integer" } } });
});

test("reaches the declarations the request is actually built from", () => {
	const parameters = { type: "object", properties: { limit: { type: "integer", minimum: 1 } } };
	const messages = [
		{ role: "system", toolsAdded: [{ name: "read_subsession", parameters }] },
		{ role: "user", content: [] },
		{ role: "system", toolsRemoved: [{ name: "read_subsession" }] },
	];

	assert.equal(stripRefusedBoundsInMessages(messages), 1);
	assert.equal(JSON.stringify(parameters).includes("minimum"), false);
});

test("is idempotent, so sweeping every request costs nothing", () => {
	const messages = [{ role: "system", toolsAdded: [{ name: "tool", parameters: { type: "integer", minimum: 0 } }] }];
	assert.equal(stripRefusedBoundsInMessages(messages), 1);
	assert.equal(stripRefusedBoundsInMessages(messages), 0);
});

test("survives a context without messages", () => {
	assert.equal(stripRefusedBoundsInMessages(undefined), 0);
	assert.equal(stripRefusedBoundsInMessages({}), 0);
});
