/**
 * status-bar.test.ts — the readout against Pi's own footer (#72).
 *
 * The arithmetic is Pi's, so these assert that we take it rather than redo it:
 * `SessionStats.tokens` IS the footer's cumulative line, `tokens.total` is never
 * a numerator, the cache hit rate is the latest assistant message's, the
 * thresholds are Pi's `>70`/`>90`, and a field with no number is omitted.
 *
 * The routing tests carry the two findings that cost the most to learn:
 * `entry_appended` is not a usage signal, and a relayed request sent while a
 * resume is in flight is refused into the user's transcript.
 */

import assert from "node:assert/strict";
import {
  contextTone, formatTokens, initialStatus, readout, routeStatusFrame, statusReducer,
  STATUS_ID, type SessionStats, type StatusState,
} from "../src/status-bar.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { console.error(`FAIL: ${name}\n`, e); process.exit(1); }
}

/** An assistant entry carrying usage — what the hit rate is read from. */
function assistant(u: { input?: number; cacheRead?: number; cacheWrite?: number }) {
  return {
    type: "message",
    message: {
      role: "assistant",
      usage: { input: u.input ?? 0, output: 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, cost: { total: 0 } },
    },
  };
}

/** A `get_session_stats` payload. */
function stats(t: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
               cost = 0, contextUsage?: SessionStats["contextUsage"]): SessionStats {
  return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...t }, cost, contextUsage };
}

const withStats = (t: Parameters<typeof stats>[0], cost = 0, from: StatusState = initialStatus) =>
  statusReducer(from, { t: "stats", stats: stats(t, cost) });

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

// --- the cumulative line comes from Pi -----------------------------------

test("the cumulative fields are Pi's totals, taken not recomputed", () => {
  const s = withStats({ input: 12000, output: 800, cacheRead: 30000, cacheWrite: 2000 }, 0.41);
  assert.deepEqual(readout(s).fields.map((f) => `${f.key}${f.value}`), ["↑12k", "↓800", "R30k", "W2.0k"]);
  assert.equal(readout(s).cost, "$0.410");
});

test("stats replace rather than accumulate — two answers are not two sessions", () => {
  const once = withStats({ input: 100 });
  const twice = withStats({ input: 150 }, 0, once);
  assert.equal(twice.totals.input, 150, "Pi's totals are already cumulative");
});

test("malformed or missing stats never poison the totals with NaN", () => {
  const s = statusReducer(initialStatus, {
    t: "stats", stats: { tokens: { input: "lots", output: null } as never, cost: "free" as never },
  });
  assert.deepEqual(s.totals, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  const empty = statusReducer(initialStatus, { t: "stats", stats: {} });
  assert.equal(Number.isFinite(empty.totals.cost), true);
});

// --- the one field entries are read for ----------------------------------

test("the cache hit rate is the latest assistant's, not a session average", () => {
  const s = statusReducer(
    withStats({ cacheRead: 1000, input: 1000 }),
    { t: "entries", entries: [assistant({ input: 100, cacheRead: 900 }), assistant({ input: 900, cacheRead: 100 })], incremental: false },
  );
  assert.equal(s.cacheHitRate?.toFixed(1), "10.0");
  assert.equal(readout(s).fields.find((f) => f.key === "CH")?.value, "10.0%");
});

test("an assistant message with no prompt tokens clears the rate", () => {
  let s = statusReducer(withStats({ cacheRead: 500, input: 500 }),
    { t: "entries", entries: [assistant({ input: 500, cacheRead: 500 })], incremental: false });
  assert.equal(s.cacheHitRate?.toFixed(1), "50.0");
  s = statusReducer(s, { t: "entries", entries: [assistant({})], incremental: true });
  assert.equal(s.cacheHitRate, undefined);
  // The cache totals still show — they are Pi's — but CH does not.
  assert.deepEqual(readout(s).fields.map((f) => f.key), ["↑", "R"]);
});

test("a cursored page with no assistant message leaves the rate standing", () => {
  const s = statusReducer(withStats({ cacheRead: 1, input: 1 }),
    { t: "entries", entries: [assistant({ input: 100, cacheRead: 900 })], incremental: false });
  const after = statusReducer(s, { t: "entries", entries: [{ type: "custom", customType: "x" }], incremental: true });
  assert.equal(after.cacheHitRate?.toFixed(1), "90.0", "nothing new arrived; the latest is still the latest");
});

test("a full read with no assistant message clears the rate", () => {
  const s = statusReducer(withStats({ cacheRead: 1, input: 1 }),
    { t: "entries", entries: [assistant({ input: 100, cacheRead: 900 })], incremental: false });
  const after = statusReducer(s, { t: "entries", entries: [], incremental: false });
  assert.equal(after.cacheHitRate, undefined, "the session genuinely has none");
});

test("leafId becomes the cursor; its absence leaves the old one alone", () => {
  const s = statusReducer(initialStatus, { t: "entries", entries: [], leafId: "e-7", incremental: false });
  assert.equal(s.cursor, "e-7");
  assert.equal(statusReducer(s, { t: "entries", entries: [], leafId: null, incremental: true }).cursor, "e-7");
});

// --- the context field ---------------------------------------------------

test("a live estimate renders percent over the window, with (auto)", () => {
  const s = statusReducer(initialStatus, {
    t: "stats", stats: stats({}, 0, { tokens: 42000, contextWindow: 200000, percent: 21 }),
  });
  assert.equal(readout(s).context?.text, "21.0%/200k (auto)");
  assert.equal(readout(s).context?.tone, "normal");
});

test("auto-compaction off drops the suffix, not the field", () => {
  const s = statusReducer({ ...initialStatus, autoCompaction: false }, {
    t: "stats", stats: stats({}, 0, { tokens: 1000, contextWindow: 200000, percent: 0.5 }),
  });
  assert.equal(readout(s).context?.text, "0.5%/200k");
});

test("a null numerator keeps the denominator: `?/{window}`", () => {
  // Pi nulls `tokens` from a compaction until the next response proves the size.
  const s = statusReducer(initialStatus, {
    t: "stats", stats: stats({}, 0, { tokens: null, contextWindow: 200000, percent: null }),
  });
  assert.equal(readout(s).context?.text, "?/200k (auto)");
  assert.equal(readout(s).context?.tone, "normal");
});

test("no contextUsage at all also reads `?`, never a 0% that means nothing", () => {
  const s: StatusState = { ...initialStatus, model: { provider: "anthropic", id: "m", contextWindow: 200000 } };
  assert.equal(readout(s).context?.text, "?/200k (auto)");
});

test("an unknown window drops the field rather than showing `?/0`", () => {
  // Pi's own `getContextUsage` returns undefined when the window is <= 0, so
  // there is never a real percentage to pair with a zero denominator.
  assert.equal(readout(initialStatus).context, undefined);
});

test("the model's own window stands in when the estimate carries none", () => {
  const s: StatusState = { ...initialStatus, model: { provider: "p", id: "m", contextWindow: 128000 } };
  assert.equal(readout(s).context?.text, "?/128k (auto)");
});

test("crossing Pi's thresholds changes the tone, not the text", () => {
  const at = (percent: number) =>
    readout(statusReducer(initialStatus, {
      t: "stats", stats: stats({}, 0, { tokens: 1, contextWindow: 200000, percent }),
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
  const s = withStats({ input: 1200, output: 340 }, 0.02);
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

test("get_state fills the right-hand side and the (auto) suffix together", () => {
  const s = statusReducer(initialStatus, {
    t: "pi_state",
    state: { model: { provider: "p", id: "m", contextWindow: 100000 }, thinkingLevel: "off", autoCompactionEnabled: false },
  });
  assert.equal(s.autoCompaction, false);
  assert.equal(readout(s).context?.text, "?/100k");
});

// --- session scope -------------------------------------------------------

test("a reset clears the session's readout AND its cursor", () => {
  let s = withStats({ input: 5000, cacheRead: 100 }, 1.5);
  s = statusReducer(s, { t: "entries", entries: [assistant({ input: 1, cacheRead: 9 })], leafId: "e-3", incremental: false });
  s = statusReducer(s, { t: "providers", count: 4 });
  s = statusReducer(s, { t: "pi_state", state: { model: { provider: "p", id: "m" } } });
  const after = statusReducer(s, { t: "reset" });
  assert.deepEqual(after.totals, initialStatus.totals);
  assert.equal(after.cacheHitRate, undefined);
  assert.equal(after.context, undefined, "a new session's context is not the old one's");
  // A cursor is an entry id in the OLD session; Pi answers a stale `since` with
  // an error, not an empty page.
  assert.equal(after.cursor, undefined);
  assert.equal(after.providerCount, 4);
  assert.equal(after.model?.id, "m");
});

// --- routing --------------------------------------------------------------

const ours = (n = 0) => `${STATUS_ID}${n}`;
const asks = (r: { ask: Array<{ type: string; since?: string }> }) =>
  r.ask.map((a) => (a.since ? `${a.type}:${a.since}` : a.type));

test("a resume asks for nothing until its switch_session answers", () => {
  // Pi does not serialize switch_session against the lines behind it, and the
  // bridge refuses relayed commands while it is pending — with an error the
  // user reads in the transcript.
  const onSession = routeStatusFrame({ type: "session", sessionId: "s1", turns: [] }, { couldResume: true });
  assert.deepEqual(onSession.ask, [], "no request may go out while a restore may be in flight");
  assert.deepEqual(onSession.actions, [{ t: "reset" }]);

  const onSwitch = routeStatusFrame({ type: "response", command: "switch_session", success: true }, { couldResume: true });
  assert.deepEqual(asks(onSwitch), ["get_session_stats", "get_entries"]);
});

test("a cancelled or failed restore still refreshes — Pi is in SOME session", () => {
  const r = routeStatusFrame({ type: "response", command: "switch_session", success: false, error: "no" }, { couldResume: true });
  assert.deepEqual(asks(r), ["get_session_stats", "get_entries"]);
});

test("a hello that named no session can ask straight away", () => {
  const r = routeStatusFrame({ type: "session", sessionId: "s1", turns: [] }, { couldResume: false });
  assert.deepEqual(asks(r), ["get_session_stats", "get_entries"]);
  assert.deepEqual(r.actions, [{ t: "reset" }]);
});

test("entry_appended is NOT a usage signal and routes to nothing", () => {
  // Pi emits it from one place only: ExtensionActions.appendEntry ->
  // appendCustomEntry. It never carries an assistant message, so a client that
  // sums it shows a cumulative line frozen at whatever the session started with.
  const r = routeStatusFrame({ type: "entry_appended", entry: assistant({ input: 999 }) }, { couldResume: false });
  assert.deepEqual(r, { actions: [], ask: [] });
});

test("a turn ending re-reads both, carrying the cursor when there is one", () => {
  assert.deepEqual(asks(routeStatusFrame({ type: "agent_end", messages: [] }, { couldResume: false })),
                   ["get_session_stats", "get_entries"]);
  assert.deepEqual(asks(routeStatusFrame({ type: "agent_end", messages: [] }, { couldResume: false, cursor: "e-4" })),
                   ["get_session_stats", "get_entries:e-4"]);
  assert.deepEqual(asks(routeStatusFrame({ type: "compaction_end", reason: "threshold" }, { couldResume: false, cursor: "e-9" })),
                   ["get_session_stats", "get_entries:e-9"]);
});

test("a cursor that outlived its branch is dropped, not retried", () => {
  // A fork or a compaction rewrites history; Pi answers a stale `since` with an
  // error rather than an empty page, so the branch is re-read whole.
  const r = routeStatusFrame(
    { type: "response", command: "get_entries", success: false, id: ours(), error: "Entry not found: e-4" },
    { couldResume: false, cursor: "e-4" },
  );
  assert.deepEqual(asks(r), ["get_entries"]);
  assert.deepEqual(r.actions, []);
});

test("get_state and set_model are taken from whoever asked", () => {
  // The bridge issues both itself and every response is forwarded to a relaying
  // socket, so gating them on our own id would throw away the answer that comes
  // first on every single session start.
  const st = routeStatusFrame(
    { type: "response", command: "get_state", success: true, data: { model: { provider: "p", id: "m" }, autoCompactionEnabled: false } },
    { couldResume: false },
  );
  assert.deepEqual(st.actions, [{ t: "pi_state", state: { model: { provider: "p", id: "m" }, autoCompactionEnabled: false } }]);
  const sm = routeStatusFrame(
    { type: "response", command: "set_model", success: true, data: { provider: "p", id: "m2" } }, { couldResume: false },
  );
  assert.equal((sm.actions[0] as { state: { model: { id: string } } }).state.model.id, "m2");
});

test("entries and stats are taken ONLY from our own requests", () => {
  const mine = routeStatusFrame(
    { type: "response", command: "get_entries", success: true, id: ours(), data: { entries: [], leafId: "e-2" } },
    { couldResume: false },
  );
  assert.equal(mine.actions.length, 1);
  // The bridge asks Pi things too; its answers carry ids we did not set.
  const theirs = routeStatusFrame(
    { type: "response", command: "get_entries", success: true, id: "bridge-7", data: { entries: [] } }, { couldResume: false },
  );
  assert.deepEqual(theirs.actions, []);
  const untagged = routeStatusFrame(
    { type: "response", command: "get_session_stats", success: true, data: {} }, { couldResume: false },
  );
  assert.deepEqual(untagged.actions, []);
});

test("an entries answer is marked incremental exactly when a cursor was held", () => {
  const frame = { type: "response", command: "get_entries", success: true, id: ours(), data: { entries: [], leafId: "e-5" } };
  const cold = routeStatusFrame(frame, { couldResume: false }).actions[0] as { incremental: boolean };
  const warm = routeStatusFrame(frame, { couldResume: false, cursor: "e-4" }).actions[0] as { incremental: boolean };
  assert.equal(cold.incremental, false);
  assert.equal(warm.incremental, true);
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
    assert.deepEqual(routeStatusFrame(f, { couldResume: false }), { actions: [], ask: [] }, JSON.stringify(f));
  }
});

test("routing feeds the reducer: a whole resume, end to end", () => {
  let s = initialStatus;
  const play = (f: Record<string, unknown>, couldResume = true) => {
    const r = routeStatusFrame(f, { couldResume, cursor: s.cursor });
    for (const a of r.actions) s = statusReducer(s, a);
    return asks(r);
  };
  play({ type: "response", command: "get_state", success: true,
         data: { model: { provider: "anthropic", id: "claude-opus-5", contextWindow: 200000, reasoning: true },
                 thinkingLevel: "high", autoCompactionEnabled: true } });
  // Before the switch answers, the bar already names the model and the window.
  assert.equal(readout(s).context?.text, "?/200k (auto)");
  assert.equal(readout(s).right, "claude-opus-5 • high");

  assert.deepEqual(play({ type: "session", sessionId: "s1", turns: [] }), []);
  assert.deepEqual(play({ type: "response", command: "switch_session", success: true }),
                   ["get_session_stats", "get_entries"]);
  play({ type: "response", command: "get_session_stats", success: true, id: ours(1),
         data: stats({ input: 12000, output: 800, cacheRead: 30000, cacheWrite: 2000 }, 0.41,
                     { tokens: 150000, contextWindow: 200000, percent: 75 }) });
  play({ type: "response", command: "get_entries", success: true, id: ours(2),
         data: { entries: [assistant({ input: 12000, cacheRead: 30000, cacheWrite: 2000 })], leafId: "e-9" } });

  const r = readout(s);
  assert.deepEqual(r.fields.map((f) => `${f.key}${f.value}`), ["↑12k", "↓800", "R30k", "W2.0k", "CH68.2%"]);
  assert.equal(r.cost, "$0.410");
  assert.equal(r.context?.text, "75.0%/200k (auto)");
  assert.equal(r.context?.tone, "warn");

  // The next turn rides the cursor rather than re-reading the whole branch.
  assert.deepEqual(play({ type: "agent_end", messages: [] }), ["get_session_stats", "get_entries:e-9"]);
});

console.log(`status-bar: ${passed} passed`);
