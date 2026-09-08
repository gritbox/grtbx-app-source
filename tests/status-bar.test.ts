/**
 * status-bar.test.ts — the readout against Pi's own footer (#72).
 *
 * The arithmetic here is a port, so the tests assert the ported behaviour
 * rather than a reasonable-looking approximation of it: the cache hit rate is
 * the LATEST assistant message's and not an average, `SessionStats.tokens` is
 * never a numerator, the thresholds are Pi's `>70`/`>90`, and a field with no
 * number is omitted rather than blanked.
 */

import assert from "node:assert/strict";
import {
  contextTone, formatTokens, initialStatus, readout, routeStatusFrame, statusReducer,
  STATUS_ID, type StatusState,
} from "../src/status-bar.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { console.error(`FAIL: ${name}\n`, e); process.exit(1); }
}

/** An assistant message entry carrying usage. */
function assistant(u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number }) {
  return {
    type: "message",
    message: {
      role: "assistant",
      usage: {
        input: u.input ?? 0, output: u.output ?? 0,
        cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0,
        cost: { total: u.cost ?? 0 },
      },
    },
  };
}

const play = (entries: unknown[], from: StatusState = initialStatus) =>
  statusReducer(from, { t: "entries", entries });

// --- formatting ----------------------------------------------------------

test("formatTokens matches the footer at every boundary", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1.0k");
  assert.equal(formatTokens(9999), "10.0k");
  assert.equal(formatTokens(10000), "10k");
  assert.equal(formatTokens(999999), "1000k");
  assert.equal(formatTokens(1000000), "1.0M");
  assert.equal(formatTokens(9999999), "10.0M");
  assert.equal(formatTokens(10000000), "10M");
});

test("thresholds are Pi's: >90 error, >70 warn, and the boundaries are not", () => {
  assert.equal(contextTone(0), "normal");
  assert.equal(contextTone(70), "normal");
  assert.equal(contextTone(70.1), "warn");
  assert.equal(contextTone(90), "warn");
  assert.equal(contextTone(90.1), "error");
  // An unknown percentage reads as 0 in the footer, so `?` is never alarming.
  assert.equal(contextTone(null), "normal");
  assert.equal(contextTone(undefined), "normal");
});

// --- the cumulative walk -------------------------------------------------

test("totals sum assistant, tool-result and summary entries alike", () => {
  const s = play([
    assistant({ input: 100, output: 20, cost: 0.5 }),
    { type: "message", message: { role: "user" } },                       // no usage
    { type: "message", message: { role: "toolResult", usage: { input: 5, cost: { total: 0.1 } } } },
    { type: "compaction", usage: { input: 7, output: 3, cost: { total: 0.25 } } },
    { type: "branch_summary", usage: { output: 1, cost: { total: 0.05 } } },
    { type: "model_change", provider: "anthropic", modelId: "x" },        // no usage
  ]);
  assert.equal(s.totals.input, 112);
  assert.equal(s.totals.output, 24);
  assert.equal(s.totals.cost.toFixed(2), "0.90");
});

test("the cache hit rate is the latest assistant's, not a session average", () => {
  const s = play([
    assistant({ input: 100, cacheRead: 900 }),  // 90%
    assistant({ input: 900, cacheRead: 100 }),  // 10% — this is the one shown
  ]);
  assert.equal(s.cacheHitRate?.toFixed(1), "10.0");
  assert.equal(readout(s).fields.find((f) => f.key === "CH")?.value, "10.0%");
});

test("an assistant message with no prompt tokens clears the rate", () => {
  const s = play([assistant({ cacheRead: 500, input: 500 }), assistant({ output: 10 })]);
  assert.equal(s.cacheHitRate, undefined);
  // The cache fields still show — they are cumulative — but CH does not.
  const f = readout(s).fields.map((x) => x.key);
  assert.deepEqual(f, ["↑", "↓", "R"]);
});

test("malformed usage never poisons the totals with NaN", () => {
  const s = play([
    { type: "message", message: { role: "assistant", usage: { input: "lots", output: null, cost: "free" } } },
    assistant({ input: 10 }),
  ]);
  assert.equal(s.totals.input, 10);
  assert.equal(s.totals.output, 0);
  assert.equal(s.totals.cost, 0);
  assert.equal(Number.isFinite(s.totals.cost), true);
});

test("`entries` replaces, so a refetch after a resume does not double", () => {
  const once = play([assistant({ input: 100 })]);
  const twice = play([assistant({ input: 100 })], once);
  assert.equal(twice.totals.input, 100);
});

test("`entry` adds one at a time, and ignores what carries no usage", () => {
  let s = play([assistant({ input: 100 })]);
  s = statusReducer(s, { t: "entry", entry: assistant({ input: 5, output: 2 }) });
  assert.equal(s.totals.input, 105);
  const before = s;
  s = statusReducer(s, { t: "entry", entry: { type: "label", targetId: "a", label: "x" } });
  assert.equal(s, before, "an entry with no usage is not even a new object");
});

// --- the context field ---------------------------------------------------

test("a live estimate renders percent over the window, with (auto)", () => {
  const s = statusReducer(
    { ...initialStatus, autoCompaction: true },
    { t: "stats", stats: { contextUsage: { tokens: 42000, contextWindow: 200000, percent: 21 } } },
  );
  assert.equal(readout(s).context?.text, "21.0%/200k (auto)");
  assert.equal(readout(s).context?.tone, "normal");
});

test("auto-compaction off drops the suffix, not the field", () => {
  const s = statusReducer(
    { ...initialStatus, autoCompaction: false },
    { t: "stats", stats: { contextUsage: { tokens: 1000, contextWindow: 200000, percent: 0.5 } } },
  );
  assert.equal(readout(s).context?.text, "0.5%/200k");
});

test("a null numerator keeps the denominator: `?/{window}`", () => {
  // Pi nulls `tokens` from a compaction until the next response proves the size.
  const s = statusReducer(initialStatus, {
    t: "stats", stats: { contextUsage: { tokens: null, contextWindow: 200000, percent: null } },
  });
  assert.equal(readout(s).context?.text, "?/200k (auto)");
  assert.equal(readout(s).context?.tone, "normal");
});

test("no contextUsage at all also reads `?`, never a 0% that means nothing", () => {
  const s: StatusState = { ...initialStatus, model: { provider: "anthropic", id: "m", contextWindow: 200000 } };
  assert.equal(readout(s).context?.text, "?/200k (auto)");
});

test("an unknown window drops the field rather than showing `?/0`", () => {
  assert.equal(readout(initialStatus).context, undefined);
});

test("the model's own window stands in when the estimate carries none", () => {
  const s: StatusState = { ...initialStatus, model: { provider: "p", id: "m", contextWindow: 128000 } };
  assert.equal(readout(s).context?.text, "?/128k (auto)");
});

test("crossing Pi's thresholds changes the tone, not the text", () => {
  const at = (percent: number) =>
    readout(statusReducer(initialStatus, {
      t: "stats", stats: { contextUsage: { tokens: 1, contextWindow: 200000, percent } },
    })).context;
  assert.equal(at(70)!.tone, "normal");
  assert.equal(at(72.5)!.tone, "warn");
  assert.equal(at(95.2)!.tone, "error");
  assert.equal(at(95.2)!.text, "95.2%/200k (auto)");
});

// --- omit rather than blank ----------------------------------------------

test("a fresh session is a context field and nothing else", () => {
  const s: StatusState = { ...initialStatus, model: { provider: "p", id: "m", contextWindow: 200000 } };
  const r = readout(s);
  assert.deepEqual(r.fields, []);
  assert.equal(r.cost, undefined);
  assert.notEqual(r.context, undefined);
});

test("no prompt cache means a shorter bar, not a padded one", () => {
  const s = play([assistant({ input: 1200, output: 340, cost: 0.02 })]);
  assert.deepEqual(readout(s).fields.map((f) => f.key), ["↑", "↓"]);
  assert.equal(readout(s).cost, "$0.020");
});

test("a subscription-backed provider shows $0.000 (sub) rather than nothing", () => {
  const s: StatusState = { ...initialStatus, model: { provider: "kimi-coding", id: "k2" } };
  assert.equal(readout(s).cost, "$0.000 (sub)");
  assert.equal(readout({ ...s, model: { provider: "anthropic", id: "m" } }).cost, undefined);
});

// --- the right-hand side -------------------------------------------------

test("the provider is named only when there is more than one", () => {
  const base: StatusState = { ...initialStatus, model: { provider: "anthropic", id: "claude-opus-5" } };
  assert.equal(readout({ ...base, providerCount: 1 }).right, "claude-opus-5");
  assert.equal(readout({ ...base, providerCount: 3 }).right, "(anthropic) claude-opus-5");
});

test("thinking appears only for a model that reasons, and says so when off", () => {
  const m = { provider: "p", id: "m", reasoning: true };
  assert.equal(readout({ ...initialStatus, model: m }).right, "m • thinking off");
  assert.equal(readout({ ...initialStatus, model: m, thinkingLevel: "high" }).right, "m • high");
  assert.equal(readout({ ...initialStatus, model: { provider: "p", id: "m" }, thinkingLevel: "high" }).right, "m");
});

test("thinking_level_changed repaints without a round trip", () => {
  const s = statusReducer(
    { ...initialStatus, model: { provider: "p", id: "m", reasoning: true } },
    { t: "thinking", level: "medium" },
  );
  assert.equal(readout(s).right, "m • medium");
});

test("get_state fills the right-hand side and the (auto) suffix together", () => {
  const s = statusReducer(initialStatus, {
    t: "pi_state",
    state: { model: { provider: "p", id: "m", contextWindow: 100000 }, thinkingLevel: "off", autoCompactionEnabled: false },
  });
  assert.equal(s.autoCompaction, false);
  assert.equal(readout(s).context?.text, "?/100k");
});

// --- session scope -------------------------------------------------------

test("a reset clears the session's usage but keeps the model and providers", () => {
  let s = play([assistant({ input: 5000, cacheRead: 100 })]);
  s = statusReducer(s, { t: "providers", count: 4 });
  s = statusReducer(s, { t: "pi_state", state: { model: { provider: "p", id: "m" } } });
  s = statusReducer(s, { t: "stats", stats: { contextUsage: { tokens: 9, contextWindow: 1000, percent: 1 } } });
  const after = statusReducer(s, { t: "reset" });
  assert.deepEqual(after.totals, initialStatus.totals);
  assert.equal(after.cacheHitRate, undefined);
  assert.equal(after.context, undefined, "a new session's context is not the old one's");
  assert.equal(after.providerCount, 4);
  assert.equal(after.model?.id, "m");
});

// --- routing: when a frame means what, and when a request is safe --------

const ours = (n = 0) => `${STATUS_ID}${n}`;

test("a resume asks for nothing until its switch_session answers", () => {
  // Pi does not serialize switch_session against the lines behind it, and the
  // bridge refuses relayed commands while it is pending — with an error the
  // user reads in the transcript. Three of those is what an eager refresh buys.
  const onSession = routeStatusFrame({ type: "session", sessionId: "s1", turns: [] }, true);
  assert.deepEqual(onSession.ask, [], "no request may go out while a restore may be in flight");
  assert.deepEqual(onSession.actions, [{ t: "reset" }]);

  const onSwitch = routeStatusFrame({ type: "response", command: "switch_session", success: true }, true);
  assert.deepEqual(onSwitch.ask, ["get_entries", "get_session_stats"]);
});

test("a cancelled or failed restore still refreshes — Pi is in SOME session", () => {
  const r = routeStatusFrame({ type: "response", command: "switch_session", success: false, error: "no" }, true);
  assert.deepEqual(r.ask, ["get_entries", "get_session_stats"]);
});

test("a hello that named no session can ask straight away", () => {
  const r = routeStatusFrame({ type: "session", sessionId: "s1", turns: [] }, false);
  assert.deepEqual(r.ask, ["get_entries", "get_session_stats"]);
  assert.deepEqual(r.actions, [{ t: "reset" }]);
});

test("an assistant entry both counts and re-reads the estimate", () => {
  const r = routeStatusFrame({ type: "entry_appended", entry: assistant({ input: 10 }) }, false);
  assert.deepEqual(r.ask, ["get_session_stats"]);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].t, "entry");
});

test("a user entry counts and asks nothing — it cannot have moved the estimate", () => {
  const r = routeStatusFrame({ type: "entry_appended", entry: { type: "message", message: { role: "user" } } }, false);
  assert.deepEqual(r.ask, []);
});

test("a compaction and a loop end each re-read the estimate", () => {
  assert.deepEqual(routeStatusFrame({ type: "compaction_end", reason: "threshold" }, false).ask, ["get_session_stats"]);
  assert.deepEqual(routeStatusFrame({ type: "agent_end", messages: [] }, false).ask, ["get_session_stats"]);
});

test("get_state and set_model are taken from whoever asked", () => {
  // The bridge issues both itself and every response is forwarded to a relaying
  // socket, so gating them on our own id would throw away the answer that comes
  // first on every single session start.
  const st = routeStatusFrame(
    { type: "response", command: "get_state", success: true, data: { model: { provider: "p", id: "m" }, autoCompactionEnabled: false } },
    false,
  );
  assert.deepEqual(st.actions, [{ t: "pi_state", state: { model: { provider: "p", id: "m" }, autoCompactionEnabled: false } }]);
  const sm = routeStatusFrame(
    { type: "response", command: "set_model", success: true, data: { provider: "p", id: "m2" } }, false,
  );
  assert.equal((sm.actions[0] as { state: { model: { id: string } } }).state.model.id, "m2");
});

test("entries and stats are taken ONLY from our own requests", () => {
  const mine = routeStatusFrame(
    { type: "response", command: "get_entries", success: true, id: ours(), data: { entries: [assistant({ input: 9 })] } }, false,
  );
  assert.equal(mine.actions.length, 1);
  // The bridge asks Pi things too; its answers carry ids we did not set.
  const theirs = routeStatusFrame(
    { type: "response", command: "get_entries", success: true, id: "bridge-7", data: { entries: [] } }, false,
  );
  assert.deepEqual(theirs.actions, []);
  const untagged = routeStatusFrame(
    { type: "response", command: "get_session_stats", success: true, data: {} }, false,
  );
  assert.deepEqual(untagged.actions, []);
});

test("a failed response is never read as data", () => {
  const r = routeStatusFrame(
    { type: "response", command: "get_session_stats", success: false, id: ours(), error: "nope" }, false,
  );
  assert.deepEqual(r, { actions: [], ask: [] });
});

test("a get_entries answer with no entries is empty, not a crash", () => {
  const r = routeStatusFrame({ type: "response", command: "get_entries", success: true, id: ours(), data: {} }, false);
  assert.deepEqual(r.actions, [{ t: "entries", entries: [] }]);
});

test("frames the bar has no business with route to nothing", () => {
  for (const f of [
    { type: "token", delta: "hi" },
    { type: "done" },
    { type: "seam", version: 1, relaying: true },
    { type: "queue_update", steering: [] },
    { type: "response", command: "prompt", success: true },
    {},
  ]) {
    assert.deepEqual(routeStatusFrame(f, false), { actions: [], ask: [] }, JSON.stringify(f));
  }
});

test("routing feeds the reducer: a whole resume, end to end", () => {
  let s = initialStatus;
  const play = (f: Record<string, unknown>, couldResume = true) => {
    const r = routeStatusFrame(f, couldResume);
    for (const a of r.actions) s = statusReducer(s, a);
    return r.ask;
  };
  play({ type: "response", command: "get_state", success: true,
         data: { model: { provider: "anthropic", id: "claude-opus-5", contextWindow: 200000, reasoning: true },
                 thinkingLevel: "high", autoCompactionEnabled: true } });
  // Before the switch answers the bar already names the model and the window.
  assert.equal(readout(s).context?.text, "?/200k (auto)");
  assert.equal(readout(s).right, "claude-opus-5 • high");

  assert.deepEqual(play({ type: "session", sessionId: "s1", turns: [] }), []);
  assert.deepEqual(play({ type: "response", command: "switch_session", success: true }),
                   ["get_entries", "get_session_stats"]);
  play({ type: "response", command: "get_entries", success: true, id: ours(1),
         data: { entries: [assistant({ input: 12000, output: 800, cacheRead: 30000, cacheWrite: 2000, cost: 0.41 })] } });
  play({ type: "response", command: "get_session_stats", success: true, id: ours(2),
         data: { contextUsage: { tokens: 150000, contextWindow: 200000, percent: 75 } } });

  const r = readout(s);
  assert.deepEqual(r.fields.map((f) => `${f.key}${f.value}`), ["↑12k", "↓800", "R30k", "W2.0k", "CH68.2%"]);
  assert.equal(r.cost, "$0.410");
  assert.equal(r.context?.text, "75.0%/200k (auto)");
  assert.equal(r.context?.tone, "warn");
});

console.log(`status-bar: ${passed} passed`);
