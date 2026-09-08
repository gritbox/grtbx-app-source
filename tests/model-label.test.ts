import assert from "node:assert/strict";
import { modelLabel } from "../src/model-label.ts";

// The provider's display name wins — the header should read like the picker.
assert.equal(modelLabel("gemini-flash-lite-latest", "google-ai-studio/gemini-3.1-flash-lite"),
             "gemini-flash-lite-latest");
assert.equal(modelLabel("Claude Opus 4.5", "anthropic/claude-opus-4-5"), "Claude Opus 4.5");

// No name (the model list hasn't loaded, or the model isn't in it) → the
// informative end of the id, not the provider prefix. This is the case that
// produced the 38-character label in #92.
assert.equal(modelLabel(undefined, "google-ai-studio/gemini-3.1-flash-lite"), "gemini-3.1-flash-lite");
assert.equal(modelLabel(null, "openai/gpt-5"), "gpt-5");

// A bare id has no prefix to drop.
assert.equal(modelLabel(undefined, "gpt-5"), "gpt-5");

// Nested prefixes: only the last segment identifies the model.
assert.equal(modelLabel(undefined, "openrouter/anthropic/claude-opus-4-5"), "claude-opus-4-5");

// Nothing at all → a word, never an empty button.
assert.equal(modelLabel(undefined, undefined), "Model");
assert.equal(modelLabel(null, null), "Model");

// Blank and whitespace-only inputs are "nothing", not a label. An empty name
// must fall through to the id rather than render a zero-width button.
assert.equal(modelLabel("", "openai/gpt-5"), "gpt-5");
assert.equal(modelLabel("   ", "openai/gpt-5"), "gpt-5");
assert.equal(modelLabel("", ""), "Model");
assert.equal(modelLabel("", "   "), "Model");

// A trailing slash leaves no segment — keep the whole id rather than blanking.
assert.equal(modelLabel(undefined, "openai/"), "openai/");

// Names are taken as the provider gives them: trimmed, never shortened. A long
// display name is CSS's problem, not this function's.
assert.equal(modelLabel("  spaced-name  ", "x/y"), "spaced-name");
assert.equal(modelLabel("a-very-long-provider-display-name-for-one-model", "x/y"),
             "a-very-long-provider-display-name-for-one-model");

console.log("model-label.test.ts: all assertions passed");
