import assert from "node:assert/strict";
import {
  steerReducer, initialSteer, nextHeld, isQueued,
  serializeHeld, parseHeld, MAX_HELD, type SteerState,
} from "../src/steering.ts";

let n = 0;
const ok = (name: string, f: () => void) => { f(); n++; void name; };

const hold = (s: SteerState, id: string, text: string) => steerReducer(s, { t: "hold", id, text });

// ---------------------------------------------------------------- held drafts

ok("a held draft is kept in order", () => {
  const s = hold(hold(initialSteer, "a", "first"), "b", "second");
  assert.deepEqual(s.held, [{ id: "a", text: "first" }, { id: "b", text: "second" }]);
});

ok("held text is trimmed, and blank is never held", () => {
  assert.deepEqual(hold(initialSteer, "a", "  spaced  ").held, [{ id: "a", text: "spaced" }]);
  assert.deepEqual(hold(initialSteer, "a", "   ").held, []);
  assert.deepEqual(hold(initialSteer, "a", "").held, []);
});

ok("holding past the cap is refused rather than silently rotating the user's words", () => {
  let s = initialSteer;
  for (let i = 0; i < MAX_HELD; i++) s = hold(s, `d${i}`, `draft ${i}`);
  assert.equal(s.held.length, MAX_HELD);
  const full = hold(s, "over", "one too many");
  assert.equal(full.held.length, MAX_HELD);
  assert.equal(full, s, "a refused hold returns the same state, so React does not re-render");
  assert.equal(full.held[0].text, "draft 0", "the OLDEST draft is the one that survives");
});

ok("unhold removes exactly one draft, and an unknown id is a no-op", () => {
  const s = hold(hold(initialSteer, "a", "first"), "b", "second");
  assert.deepEqual(steerReducer(s, { t: "unhold", id: "a" }).held, [{ id: "b", text: "second" }]);
  assert.deepEqual(steerReducer(s, { t: "unhold", id: "zzz" }).held, s.held);
});

ok("nextHeld is the oldest, so drafts flush in the order they were written", () => {
  const s = hold(hold(initialSteer, "a", "first"), "b", "second");
  assert.deepEqual(nextHeld(s), { id: "a", text: "first" });
  assert.equal(nextHeld(initialSteer), undefined);
});

// ------------------------------------------------------------- Pi's own queue

ok("queue_update is taken verbatim, never merged", () => {
  let s = steerReducer(initialSteer, { t: "queue_update", steering: ["one", "two"] });
  assert.deepEqual(s.queued, ["one", "two"]);
  // Pi re-emits the WHOLE queue on every change, so the second update replaces.
  s = steerReducer(s, { t: "queue_update", steering: ["two"] });
  assert.deepEqual(s.queued, ["two"]);
  s = steerReducer(s, { t: "queue_update", steering: [] });
  assert.deepEqual(s.queued, []);
});

ok("a non-string in queue_update is dropped rather than reaching the transcript", () => {
  const s = steerReducer(initialSteer, {
    t: "queue_update", steering: ["real", null, 7, undefined, "also real"] as unknown as string[],
  });
  assert.deepEqual(s.queued, ["real", "also real"]);
});

ok("queue_update never touches held drafts", () => {
  const s = steerReducer(hold(initialSteer, "a", "mine"), { t: "queue_update", steering: ["pi's"] });
  assert.deepEqual(s.held, [{ id: "a", text: "mine" }]);
  assert.deepEqual(s.queued, ["pi's"]);
});

// ------------------------------------------------------------------- greying

ok("isQueued greys by text, which is the only identity Pi offers", () => {
  const s = steerReducer(initialSteer, { t: "queue_update", steering: ["steer me"] });
  assert.equal(isQueued("steer me", s), true);
  assert.equal(isQueued("something else", s), false);
  assert.equal(isQueued("steer me", initialSteer), false);
});

// ------------------------------------------------------------------- reset

ok("only queue_update may empty Pi's queue — a settling run must not", () => {
  // `Agent.steer` only enqueues; nothing starts a run. So a message steered as
  // a turn ends is still queued afterwards, and anything that cleared the queue
  // on settle would ungrey a bubble Pi is still holding.
  const s = steerReducer(initialSteer, { t: "queue_update", steering: ["steered as the turn ended"] });
  assert.equal(isQueued("steered as the turn ended", s), true);
  assert.deepEqual(steerReducer(s, { t: "queue_update", steering: ["steered as the turn ended"] }).queued,
                   ["steered as the turn ended"]);
});

ok("reset drops Pi's queue but never the user's own words", () => {
  const s = steerReducer(hold(initialSteer, "a", "mine"), { t: "queue_update", steering: ["pi's"] });
  const r = steerReducer(s, { t: "reset" });
  assert.deepEqual(r.queued, []);
  assert.deepEqual(r.held, [{ id: "a", text: "mine" }]);
});

// --------------------------------------------------------------- persistence

ok("held drafts round-trip", () => {
  const held = [{ id: "a", text: "first" }, { id: "b", text: "second" }];
  assert.deepEqual(parseHeld(serializeHeld(held)), held);
});

ok("an unreadable store is an empty store, never a throw", () => {
  assert.deepEqual(parseHeld(null), []);
  assert.deepEqual(parseHeld(undefined), []);
  assert.deepEqual(parseHeld(""), []);
  assert.deepEqual(parseHeld("{not json"), []);
  assert.deepEqual(parseHeld('"a string"'), []);
  assert.deepEqual(parseHeld("null"), []);
  assert.deepEqual(parseHeld("42"), []);
  assert.deepEqual(parseHeld('{"id":"a","text":"b"}'), [], "an object is not a list");
});

ok("malformed entries are skipped, and good ones beside them survive", () => {
  assert.deepEqual(
    parseHeld('[{"id":"a","text":"keep"},null,{"id":1,"text":"bad id"},{"id":"c"},{"text":"no id"},{"id":"d","text":"  "},{"id":"e","text":" also keep "}]'),
    [{ id: "a", text: "keep" }, { id: "e", text: "also keep" }],
  );
});

ok("a store larger than the cap is truncated on restore", () => {
  const huge = JSON.stringify(Array.from({ length: MAX_HELD + 25 }, (_, i) => ({ id: `d${i}`, text: `draft ${i}` })));
  const restored = parseHeld(huge);
  assert.equal(restored.length, MAX_HELD);
  assert.equal(restored[0].text, "draft 0");
});

console.log(`steering: ${n} passed`);
