/**
 * pi-events.test.ts — the relay's transcript, driven by Pi's real event shapes.
 *
 * These assert the three findings the bridge paid for and the client now owns:
 * `agent_end` is not the end of a turn (#77), a failed run settles with
 * `stopReason: "error"` rather than a clean done (#17), and an auto-retry drops
 * what the failed attempt streamed.
 */

import assert from "node:assert/strict";
import { createPiTranslator, displayValue, isPiEvent, type PiEvent } from "../src/pi-events.ts";
import { reducer, initialState, type ChatState } from "../src/reducer.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { console.error(`FAIL: ${name}\n`, e); process.exit(1); }
}

/** Run a stream of Pi events through the translator into the reducer. */
function play(events: PiEvent[], from: ChatState = initialState): ChatState {
  const t = createPiTranslator();
  let s = from;
  for (const e of events) for (const a of t.handle(e)) s = reducer(s, a);
  return s;
}

const streaming = reducer(initialState, { t: "send", text: "hi" });

test("a text delta appends to the streaming assistant bubble", () => {
  const s = play([{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "he" } },
                  { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "llo" } }], streaming);
  assert.equal(s.messages.at(-1)!.text, "hello");
  assert.equal(s.streaming, true);
});

test("agent_end alone does NOT end the turn (#77)", () => {
  const s = play([{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } },
                  { type: "agent_end", messages: [{ role: "assistant", stopReason: "endTurn" }] }], streaming);
  assert.equal(s.streaming, true, "agent_end is the end of a loop, not the turn");
  assert.equal(s.messages.at(-1)!.text, "partial");
});

test("agent_settled ends the turn", () => {
  const s = play([{ type: "agent_end", messages: [{ role: "assistant", stopReason: "endTurn" }] },
                  { type: "agent_settled" }], streaming);
  assert.equal(s.streaming, false);
  assert.equal(s.messages.some((m) => m.role === "error"), false);
});

test("a failed run settles as an error, not a silent done (#17)", () => {
  const s = play([{ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "rate limited" }] },
                  { type: "agent_settled" }], streaming);
  assert.equal(s.streaming, false);
  const err = s.messages.at(-1)!;
  assert.equal(err.role, "error");
  assert.equal(err.text, "rate limited");
});

test("an aborted run is a normal end, not an error", () => {
  const s = play([{ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] },
                  { type: "agent_settled" }], streaming);
  assert.equal(s.messages.some((m) => m.role === "error"), false);
  assert.equal(s.streaming, false);
});

test("settling without any agent_end is a clean done", () => {
  const s = play([{ type: "agent_settled" }], streaming);
  assert.equal(s.streaming, false);
  assert.equal(s.messages.some((m) => m.role === "error"), false);
});

test("auto_retry_start drops what the failed attempt streamed", () => {
  const s = play([{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "doomed" } },
                  { type: "auto_retry_start", attempt: 1 },
                  { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "retried" } }], streaming);
  assert.equal(s.messages.at(-1)!.text, "retried", "the retry must not glue onto the attempt it replaced");
});

test("tool lifecycle produces running -> ok with its output", () => {
  const s = play([{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { cmd: "ls" } },
                  { type: "tool_execution_update", toolCallId: "t1", partialResult: "part" },
                  { type: "tool_execution_end", toolCallId: "t1", isError: false, result: "done" }], streaming);
  const tools = s.messages.at(-1)!.tools!;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "bash");
  assert.equal(tools[0].status, "ok");
  assert.equal(tools[0].output, "done");
});

test("a failed tool ends as error", () => {
  const s = play([{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" },
                  { type: "tool_execution_end", toolCallId: "t1", isError: true, result: "boom" }], streaming);
  assert.equal(s.messages.at(-1)!.tools![0].status, "error");
});

test("an inference error mid-stream surfaces as a message", () => {
  const s = play([{ type: "message_update", assistantMessageEvent: { type: "error", error: "context overflow" } }], streaming);
  assert.equal(s.messages.at(-1)!.role, "error");
  assert.equal(s.messages.at(-1)!.text, "context overflow");
});

test("events the translator has no case for are ignored, not crashed on", () => {
  const s = play([{ type: "queue_update", steering: [], followUp: [] },
                  { type: "compaction_start", reason: "threshold" },
                  { type: "thinking_level_changed", level: "high" }], streaming);
  assert.deepEqual(s, streaming);
});

test("isPiEvent separates Pi's stream from the bridge's own frames", () => {
  assert.equal(isPiEvent({ type: "agent_settled" }), true);
  assert.equal(isPiEvent({ type: "message_update" }), true);
  // BridgeMsg types must never be mistaken for Pi events, or both paths fire.
  for (const t of ["token", "done", "error", "tool_start", "tool_end", "session", "seam", "models"]) {
    assert.equal(isPiEvent({ type: t }), false, `${t} is a bridge frame`);
  }
});

test("displayValue unwraps Pi's result shapes", () => {
  assert.equal(displayValue("plain"), "plain");
  assert.equal(displayValue({ content: [{ text: "a" }, { text: "b" }] }), "a\nb");
  assert.equal(displayValue({ text: "t" }), "t");
  assert.equal(displayValue(undefined), "");
  assert.equal(displayValue(null), "");
  assert.equal(displayValue({ n: 1 }), '{"n":1}');
});

console.log(`pi-events: ${passed} passed`);
