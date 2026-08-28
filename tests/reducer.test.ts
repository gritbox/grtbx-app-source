import assert from "node:assert/strict";
import { reducer, initialState, type ChatState } from "../src/reducer.ts";

function run(actions: Parameters<typeof reducer>[1][]): ChatState {
  return actions.reduce((s, a) => reducer(s, a), initialState);
}

// send creates a user bubble + an empty assistant bubble and starts streaming
{
  const s = run([{ t: "send", text: "hello" }]);
  assert.equal(s.messages.length, 2);
  assert.deepEqual(s.messages[0], { id: 1, role: "user", text: "hello" });
  assert.deepEqual(s.messages[1], { id: 2, role: "assistant", text: "" });
  assert.equal(s.streaming, true);
}

// tokens append to the assistant bubble in order
{
  const s = run([{ t: "send", text: "hi" }, { t: "token", delta: "Hel" }, { t: "token", delta: "lo" }]);
  assert.equal(s.messages[1].text, "Hello");
  assert.equal(s.streaming, true);
}

// U+2028 inside a delta survives
{
  const LS = String.fromCharCode(0x2028);
  const s = run([{ t: "send", text: "hi" }, { t: "token", delta: "a" + LS + "b" }]);
  assert.equal(s.messages[1].text, "a" + LS + "b");
}

// done stops streaming, keeps the text
{
  const s = run([{ t: "send", text: "hi" }, { t: "token", delta: "Hi" }, { t: "done" }]);
  assert.equal(s.streaming, false);
  assert.equal(s.messages[1].text, "Hi");
}

// tokens after done are ignored (not streaming)
{
  const s = run([{ t: "send", text: "hi" }, { t: "done" }, { t: "token", delta: "late" }]);
  assert.equal(s.messages[1].text, "");
}

// error surfaces as a message and stops streaming; partial text remains
{
  const s = run([{ t: "send", text: "hi" }, { t: "token", delta: "par" }, { t: "error", message: "gateway boom" }]);
  assert.equal(s.streaming, false);
  assert.equal(s.messages[1].text, "par", "partial assistant text kept");
  const err = s.messages[s.messages.length - 1];
  assert.equal(err.role, "error");
  assert.equal(err.text, "gateway boom");
}

// tool_start/tool_update/tool_end (issue #2): rows attach to the in-flight assistant bubble
{
  const s = run([
    { t: "send", text: "run a tool" },
    { t: "tool_start", toolCallId: "tc-1", name: "bash", args: { command: "echo hi" } },
    { t: "tool_update", toolCallId: "tc-1", output: "hi" },
    { t: "tool_end", toolCallId: "tc-1", ok: true, output: "hi\n" },
    { t: "token", delta: "done!" },
  ]);
  const tools = s.messages[1].tools;
  assert.equal(tools?.length, 1);
  assert.equal(tools?.[0].name, "bash");
  assert.deepEqual(tools?.[0].args, { command: "echo hi" });
  assert.equal(tools?.[0].output, "hi\n");
  assert.equal(tools?.[0].status, "ok");
  assert.equal(s.messages[1].text, "done!", "text still streams alongside tool rows");
}

// a tool call that fails is marked error, not silently dropped
{
  const s = run([
    { t: "send", text: "run a tool" },
    { t: "tool_start", toolCallId: "tc-1", name: "bash", args: { command: "false" } },
    { t: "tool_end", toolCallId: "tc-1", ok: false, output: "boom" },
  ]);
  assert.equal(s.messages[1].tools?.[0].status, "error");
}

// a tool call still "running" when the turn ends (e.g. stopped mid-call) never spins forever
{
  const s = run([
    { t: "send", text: "run a tool" },
    { t: "tool_start", toolCallId: "tc-1", name: "bash", args: {} },
    { t: "done" },
  ]);
  assert.equal(s.messages[1].tools?.[0].status, "stopped", "no infinite spinner after done");
}

// same, but the turn ends via error instead of done
{
  const s = run([
    { t: "send", text: "run a tool" },
    { t: "tool_start", toolCallId: "tc-1", name: "bash", args: {} },
    { t: "error", message: "gateway boom" },
  ]);
  assert.equal(s.messages[1].tools?.[0].status, "stopped", "no infinite spinner after error");
}

// tool events after streaming has ended are ignored, like late tokens
{
  const s = run([
    { t: "send", text: "hi" }, { t: "done" },
    { t: "tool_start", toolCallId: "tc-1", name: "bash", args: {} },
  ]);
  assert.equal(s.messages[1].tools, undefined);
}

// a new send after done/stop streams again into a fresh assistant bubble
{
  const s = run([
    { t: "send", text: "one" }, { t: "token", delta: "1" }, { t: "done" },
    { t: "send", text: "two" }, { t: "token", delta: "2" },
  ]);
  assert.equal(s.messages.length, 4);
  assert.equal(s.messages[3].text, "2");
  assert.equal(s.streaming, true);
}

// load_session (issue #4) replaces the whole transcript and resets streaming/ids
{
  const s = run([
    { t: "send", text: "one" }, { t: "token", delta: "1" }, { t: "done" },
    { t: "load_session", turns: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello!" }] },
  ]);
  assert.equal(s.messages.length, 2);
  assert.deepEqual(s.messages[0], { id: 1, role: "user", text: "hi" });
  assert.deepEqual(s.messages[1], { id: 2, role: "assistant", text: "hello!" });
  assert.equal(s.streaming, false);

  // a send right after a loaded session still works with fresh, non-colliding ids
  const s2 = reducer(s, { t: "send", text: "more" });
  assert.equal(s2.messages.length, 4);
  assert.equal(s2.messages[2].text, "more");
}

// load_session with no turns (brand-new session) empties the transcript
{
  const s = run([
    { t: "send", text: "one" },
    { t: "load_session", turns: [] },
  ]);
  assert.equal(s.messages.length, 0);
  assert.equal(s.streaming, false);
}

// disconnected (issue #5): a drop mid-turn stops the local spinner and any
// running tool rows, but appends no visible error — the reconnect's replayed
// transcript is the truth, not a client-side guess
{
  const s = run([
    { t: "send", text: "run a tool" },
    { t: "tool_start", toolCallId: "tc-1", name: "bash", args: {} },
    { t: "token", delta: "wor" },
    { t: "disconnected" },
  ]);
  assert.equal(s.streaming, false);
  assert.equal(s.messages[1].text, "wor", "partial text kept, same as done/error");
  assert.equal(s.messages[1].tools?.[0].status, "stopped", "no infinite spinner across a drop");
  assert.equal(s.messages.length, 2, "no error bubble appended — a drop isn't a failure to report");
}

// disconnected with nothing in flight is a no-op (safe to fire on every
// connection-state change, not just ones that interrupt a turn)
{
  const s = run([{ t: "disconnected" }]);
  assert.deepEqual(s, initialState);
}

console.log("reducer.test OK");
