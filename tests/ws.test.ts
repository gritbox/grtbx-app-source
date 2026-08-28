import assert from "node:assert/strict";
import {
  connect,
  backoffBaseMs,
  withJitter,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
  RECONNECT_MAX_ATTEMPTS,
  type WsEnv,
  type WsLike,
  type ConnState,
  type BridgeMsg,
} from "../src/ws.ts";

// --- test doubles: no browser, no real sockets, no real timers -------------

type Listener = (ev: { data?: unknown }) => void;

class FakeSocket implements WsLike {
  readyState = 0; // CONNECTING
  sent: string[] = [];
  private listeners: Record<string, Listener[]> = { open: [], close: [], error: [], message: [] };
  constructor(public url: string) {}
  addEventListener(type: string, cb: Listener) { (this.listeners[type] ??= []).push(cb); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.fire("close"); }
  // test-only helpers simulating server/browser behavior:
  open() { this.readyState = 1; this.fire("open"); }
  drop() { this.readyState = 3; this.fire("close"); } // simulates a real socket drop
  message(obj: unknown) { this.fire("message", { data: JSON.stringify(obj) }); }
  private fire(type: string, ev: { data?: unknown } = {}) { for (const cb of this.listeners[type] ?? []) cb(ev); }
  lastSent(): unknown { return JSON.parse(this.sent[this.sent.length - 1]); }
}

class FakeClock {
  now = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private nextId = 1;
  setTimer(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.push({ id, at: this.now + ms, fn });
    return id;
  }
  clearTimer(id: unknown) { this.timers = this.timers.filter((t) => t.id !== id); }
  advance(ms: number) {
    this.now += ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= this.now).sort((a, b) => a.at - b.at);
      if (due.length === 0) return;
      this.timers = this.timers.filter((t) => t.id !== due[0].id);
      due[0].fn();
    }
  }
}

function testHarness(opts: { hidden?: boolean } = {}) {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const states: ConnState[] = [];
  const msgs: BridgeMsg[] = [];
  let hidden = opts.hidden ?? false;
  let visCb: (() => void) | null = null;
  const env: WsEnv = {
    wsUrl: () => "ws://test/ws",
    createSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    setTimer: (fn, ms) => clock.setTimer(fn, ms),
    clearTimer: (h) => clock.clearTimer(h),
    isHidden: () => hidden,
    onVisibilityChange: (cb) => { visCb = cb; return () => { visCb = null; }; },
    random: () => 0.5, // midpoint => withJitter(base) === base exactly, deterministic assertions
  };
  return {
    clock, sockets, states, msgs, env,
    setHidden(v: boolean) { hidden = v; visCb?.(); },
    onMsg: (m: BridgeMsg) => msgs.push(m),
    onState: (s: ConnState) => states.push(s),
  };
}

// --- pure backoff math -------------------------------------------------

{
  assert.equal(RECONNECT_INITIAL_MS, 1000);
  assert.equal(RECONNECT_MAX_MS, 30000);
  assert.equal(RECONNECT_MAX_ATTEMPTS, 6);
  // 1s -> 2s -> 4s -> 8s -> 16s -> capped at 30s
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(backoffBaseMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
}

{
  // ±20% jitter, bounded and centered on the base
  assert.equal(withJitter(1000, () => 0.5), 1000);
  assert.equal(withJitter(1000, () => 0), 800);
  assert.equal(withJitter(1000, () => 1), 1200);
}

// --- reconnect state machine --------------------------------------------

// happy path: connects, opens, sends hello with the given sessionId
{
  const h = testHarness();
  connect(h.onMsg, h.onState, "sess-abc", h.env);
  assert.equal(h.sockets.length, 1);
  assert.deepEqual(h.states, ["connecting"]);
  h.sockets[0].open();
  assert.deepEqual(h.states, ["connecting", "open"]);
  assert.deepEqual(h.sockets[0].lastSent(), { type: "hello", sessionId: "sess-abc" });
}

// a socket drop reconnects with capped exponential backoff and re-hellos with
// the current sessionId (a normal drop: sleep/wake, network blip, tab kill)
{
  const h = testHarness();
  connect(h.onMsg, h.onState, "sess-abc", h.env);
  h.sockets[0].open();
  h.sockets[0].drop();
  assert.deepEqual(h.states.slice(-1), ["reconnecting"]);
  assert.equal(h.sockets.length, 1, "no new socket before the backoff elapses");

  h.clock.advance(999);
  assert.equal(h.sockets.length, 1, "not yet — one ms short of the 1s backoff");
  h.clock.advance(1);
  assert.equal(h.sockets.length, 2, "reconnects after the first backoff (1s)");
  h.sockets[1].open();
  assert.deepEqual(h.sockets[1].lastSent(), { type: "hello", sessionId: "sess-abc" }, "re-hellos on reconnect");
  assert.deepEqual(h.states.slice(-1), ["open"]);
}

// re-hello uses the *latest* sessionId once the bridge has confirmed one
// (e.g. a fresh new_session mid-conversation), not the one connect() was given
{
  const h = testHarness();
  connect(h.onMsg, h.onState, undefined, h.env);
  h.sockets[0].open();
  h.sockets[0].message({ type: "session", sessionId: "minted-1", turns: [] });
  assert.deepEqual(h.msgs, [{ type: "session", sessionId: "minted-1", turns: [] }], "decoded messages still reach the UI");

  h.sockets[0].drop();
  h.clock.advance(backoffBaseMs(1));
  assert.equal(h.sockets.length, 2);
  h.sockets[1].open();
  assert.deepEqual(h.sockets[1].lastSent(), { type: "hello", sessionId: "minted-1" });
}

// bounded attempts: repeated *consecutive* failures (the network never comes
// back) exhaust the retry budget and go dormant ("offline") rather than
// looping forever — issue #12's hard requirement. (A successful open resets
// the counter — that's covered separately below — so this simulates a run of
// attempts that never reconnect at all.)
{
  const h = testHarness();
  connect(h.onMsg, h.onState, "sess-abc", h.env);
  h.sockets[0].open();
  h.sockets[0].drop(); // the only successful open; everything after this fails

  for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt++) {
    assert.deepEqual(h.states.slice(-1), ["reconnecting"], `attempt ${attempt} retries`);
    assert.equal(h.sockets.length, attempt, `attempt ${attempt} hasn't opened a new socket yet`);
    h.clock.advance(backoffBaseMs(attempt));
    assert.equal(h.sockets.length, attempt + 1, `attempt ${attempt} opened a new (still-failed) socket`);
    h.sockets[h.sockets.length - 1].drop(); // this attempt fails too
  }

  // the budget is exhausted -> dormant, no further sockets ever
  assert.deepEqual(h.states.slice(-1), ["offline"]);
  const socketCountAtOffline = h.sockets.length;
  h.clock.advance(10 * RECONNECT_MAX_MS);
  assert.equal(h.sockets.length, socketCountAtOffline, "dormant: no timers keep firing once offline");
}

// a successful reconnect resets the failure counter — a long-lived flaky
// connection doesn't slowly ratchet towards "offline" on unrelated blips
{
  const h = testHarness();
  connect(h.onMsg, h.onState, "sess-abc", h.env);
  h.sockets[0].open();
  for (let i = 0; i < RECONNECT_MAX_ATTEMPTS + 3; i++) {
    const last = h.sockets[h.sockets.length - 1];
    last.drop();
    h.clock.advance(backoffBaseMs(1)); // always the *first* backoff — never climbs
    const next = h.sockets[h.sockets.length - 1];
    next.open();
    assert.deepEqual(h.states.slice(-1), ["open"], `blip ${i} recovers`);
  }
}

// don't hammer a hidden tab: a drop while hidden pauses; becoming visible
// again retries immediately rather than waiting out the remaining backoff
{
  const h = testHarness({ hidden: false });
  connect(h.onMsg, h.onState, "sess-abc", h.env);
  h.sockets[0].open();
  h.setHidden(true);
  h.sockets[0].drop();
  assert.deepEqual(h.states.slice(-1), ["reconnecting"]);
  h.clock.advance(10 * RECONNECT_MAX_MS);
  assert.equal(h.sockets.length, 1, "no reconnect attempts fire while the tab is hidden");

  h.setHidden(false);
  assert.equal(h.sockets.length, 2, "wake retries immediately, not after another full backoff");
  h.sockets[1].open();
  assert.deepEqual(h.states.slice(-1), ["open"]);
}

// issue #11: a resume-failure error frame arrives over a socket that never
// closed (the bridge only killed the wedged Pi child) — the client re-`hello`s
// through the *same* bounded backoff, not a tight loop, and never opens a
// second socket for it
{
  const h = testHarness();
  connect(h.onMsg, h.onState, "sess-abc", h.env);
  h.sockets[0].open();
  const before = h.sockets[0].sent.length;

  h.sockets[0].message({ type: "error", message: "could not resume the session — please retry" });
  assert.deepEqual(h.states.slice(-1), ["reconnecting"]);
  assert.equal(h.sockets.length, 1, "the socket itself is fine — no reopen");

  h.clock.advance(backoffBaseMs(1));
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].sent.length, before + 1, "exactly one re-hello sent");
  assert.deepEqual(h.sockets[0].lastSent(), { type: "hello", sessionId: "sess-abc" });

  // and it's bounded exactly like a socket-drop retry: repeat past the cap
  for (let attempt = 2; attempt <= RECONNECT_MAX_ATTEMPTS; attempt++) {
    h.sockets[0].message({ type: "error", message: "could not resume the session — please retry" });
    h.clock.advance(backoffBaseMs(attempt));
  }
  assert.equal(h.sockets[0].sent.length, before + RECONNECT_MAX_ATTEMPTS, "one re-hello per bounded attempt");
  h.sockets[0].message({ type: "error", message: "could not resume the session — please retry" });
  assert.deepEqual(h.states.slice(-1), ["offline"]);
  h.clock.advance(10 * RECONNECT_MAX_MS);
  assert.equal(h.sockets[0].sent.length, before + RECONNECT_MAX_ATTEMPTS, "no more re-hellos once dormant");
}

// a resume-failure retry that succeeds resets the attempt counter back to "open"
{
  const h = testHarness();
  connect(h.onMsg, h.onState, "sess-abc", h.env);
  h.sockets[0].open();
  h.sockets[0].message({ type: "error", message: "could not resume the session — please retry" });
  h.clock.advance(backoffBaseMs(1));
  h.sockets[0].message({ type: "session", sessionId: "sess-abc", turns: [] });
  assert.deepEqual(h.states.slice(-1), ["open"]);

  // the counter is back at zero, not still climbing from the earlier retry
  h.sockets[0].drop();
  h.clock.advance(backoffBaseMs(1));
  assert.equal(h.sockets.length, 2, "the very next backoff after recovery is the 1s one, not further along");
}

// unrelated errors (a normal inference failure, a bad model switch, ...) never
// trigger the reconnect machinery — only the specific resume-timeout frame does
{
  const h = testHarness();
  connect(h.onMsg, h.onState, "sess-abc", h.env);
  h.sockets[0].open();
  h.sockets[0].message({ type: "error", message: "the agent exited unexpectedly (code 1)" });
  assert.deepEqual(h.states.slice(-1), ["open"], "an ordinary error frame doesn't flip connection state");
  assert.equal(h.sockets[0].sent.length, 1, "no retry hello sent");
}

// a send while the socket isn't open never reaches the wire — never a silent
// "looks sent but wasn't"; the UI layer (App.tsx) is responsible for the
// visible, immediate failure on top of this transport-level guard
{
  const h = testHarness();
  const conn = connect(h.onMsg, h.onState, "sess-abc", h.env);
  // socket0 exists but hasn't opened yet — readyState is CONNECTING
  conn.send("hello?");
  assert.deepEqual(h.sockets[0].sent, [], "nothing written to a socket that isn't open");
}

// manual reconnect() (the offline banner's affordance) resets the budget and
// retries immediately, without waiting for a timer
{
  const h = testHarness();
  const conn = connect(h.onMsg, h.onState, "sess-abc", h.env);
  h.sockets[0].open();
  h.sockets[0].drop(); // the only successful open; everything after this fails
  for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt++) {
    h.clock.advance(backoffBaseMs(attempt));
    h.sockets[h.sockets.length - 1].drop();
  }
  assert.deepEqual(h.states.slice(-1), ["offline"]);

  const socketCountAtOffline = h.sockets.length; // 1 (opened) + RECONNECT_MAX_ATTEMPTS (all failed)
  conn.reconnect();
  assert.equal(h.sockets.length, socketCountAtOffline + 1, "reconnect() opens immediately, no timer wait");
  h.sockets[h.sockets.length - 1].open();
  assert.deepEqual(h.states.slice(-1), ["open"]);

  // and the budget is reset — the next drop starts back at the 1s backoff
  h.sockets[h.sockets.length - 1].drop();
  const socketCountBefore = h.sockets.length;
  h.clock.advance(999);
  assert.equal(h.sockets.length, socketCountBefore);
  h.clock.advance(1);
  assert.equal(h.sockets.length, socketCountBefore + 1);
}

// close() is a real teardown: no reconnect follows it (unmount, not a drop)
{
  const h = testHarness();
  const conn = connect(h.onMsg, h.onState, "sess-abc", h.env);
  h.sockets[0].open();
  conn.close();
  assert.equal(h.sockets[0].readyState, 3);
  h.clock.advance(10 * RECONNECT_MAX_MS);
  assert.equal(h.sockets.length, 1, "an intentional close never reconnects");
}

console.log("ws.test OK");
