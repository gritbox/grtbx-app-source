/**
 * ws.ts — the client half of the protocol.ts contract. Connects same-origin to
 * /ws (the auth cookie rides along automatically — no token in JS), relays
 * `send`/`stop`/`hello`/`new_session`/`list_sessions`/`list_models`/`set_model`/
 * `connect_provider`/`list_workspaces`/`set_workspace`/`create_workspace` up
 * and `token`/`done`/`error`/`session`/`sessions`/`models`/`model_set`/
 * `workspaces` down. `connect_provider` (issue #31) has no dedicated
 * ack — the `models` reply it triggers (or an `error`) is the signal.
 * The transport is isolated here so the UI only ever sees decoded messages
 * (the AG-UI seam).
 *
 * Reconnect (issue #5): the socket auto-reconnects after any drop (sleep/wake,
 * network blip, backgrounded tab) with capped exponential backoff + jitter,
 * bounded to `RECONNECT_MAX_ATTEMPTS` consecutive failures before going
 * dormant ("offline") — this is the codebase's first automatic retry loop and
 * issue #12 requires it can never run away. On every successful (re)connect
 * we re-`hello` with the last-known sessionId so the bridge replays the
 * transcript (`session` message → `load_session`) and restores agent memory
 * (ADR-006); the replayed transcript is authoritative, so a reconnect never
 * duplicates turns. The bridge's #11 watchdog error ("could not resume the
 * session — please retry") — sent over a socket that stays open — is routed
 * through the *same* bounded backoff as a real re-`hello`, not a tight loop.
 * All IO (socket construction, timers, page-visibility, jitter source) goes
 * through `WsEnv` so this state machine is unit-testable without a browser.
 */

export interface SessionTurn {
  role: "user" | "assistant";
  text: string;
  ts: string;
}

export interface SessionSummary {
  id: string;
  updatedAt: string;
  preview: string;
}

export interface ModelSummary {
  provider: string;
  id: string;
  name: string;
}

/** One place a session can be started (#50): the root, a project, or a sibling
 *  like the live surface. `path` is absent only for a root that inherits. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  kind: "root" | "project" | "sibling";
  path?: string;
}

export type BridgeMsg =
  | { type: "token"; delta: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "tool_start"; toolCallId: string; name: string; args?: unknown }
  | { type: "tool_update"; toolCallId: string; output: string }
  | { type: "tool_end"; toolCallId: string; ok: boolean; output?: string }
  | { type: "session"; sessionId: string; turns: SessionTurn[]; workspaceId?: string }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "models"; models: ModelSummary[]; current?: { provider: string; modelId: string } }
  | { type: "model_set"; provider: string; modelId: string }
  | { type: "model_prompts"; prompts: ModelPromptMap }
  | { type: "workspaces"; workspaces: WorkspaceSummary[]; current?: string };

/** provider -> modelId -> the user's framing for that model (#42). */
export type ModelPromptMap = Record<string, Record<string, string>>;

/** connecting = first attempt in flight; reconnecting = a bounded retry after a drop. */
export type ConnState = "connecting" | "open" | "reconnecting" | "offline";

/** A user-owned endpoint Pi has no built-in entry for (issue #34, ADR-011). */
export interface CustomProviderSpec {
  id: string;
  name?: string;
  baseUrl: string;
  apiKey: string;
  models: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean }>;
}

export interface Conn {
  send(text: string): void;
  stop(): void;
  hello(sessionId?: string): void;
  newSession(): void;
  listSessions(): void;
  listModels(): void;
  setModel(provider: string, modelId: string): void;
  /** BYO first-party provider key (issue #31, ADR-011). */
  connectProvider(provider: string, apiKey: string): void;
  /** BYO custom / self-hosted endpoint (issue #34, ADR-011). */
  connectCustomProvider(spec: CustomProviderSpec): void;
  /** The workspace picker's contents (issue #50). */
  listWorkspaces(): void;
  /** Start a NEW session in that workspace — Pi's instructions are fixed at spawn. */
  setWorkspace(workspaceId: string): void;
  /** Create `workspaces/<name>`; the refreshed list is the ack. */
  createWorkspace(name: string): void;
  /** Per-model system prompts (issue #42). */
  listModelPrompts(): void;
  /** An empty `prompt` clears that model's framing. */
  setModelPrompt(provider: string, modelId: string, prompt: string): void;
  /** Manual retry affordance for the "offline" (bounded-attempts-exhausted) state. */
  reconnect(): void;
  close(): void;
}

// --- bounded backoff -------------------------------------------------------

export const RECONNECT_INITIAL_MS = 1000;
export const RECONNECT_MAX_MS = 30000;
export const RECONNECT_MAX_ATTEMPTS = 6; // consecutive failures before going dormant ("offline")
const JITTER_RATIO = 0.2;

/** Capped exponential backoff before jitter. `attempt` is 1-based. */
export function backoffBaseMs(attempt: number): number {
  return Math.min(RECONNECT_INITIAL_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
}

/** ±`JITTER_RATIO` jitter around a base delay. `rand()` in [0, 1); injectable for tests. */
export function withJitter(baseMs: number, rand: () => number = Math.random): number {
  const span = baseMs * JITTER_RATIO;
  return Math.max(0, baseMs + (rand() * 2 - 1) * span);
}

/** The bridge error that means "the resume's switch_session hung — retry the hello" (#11). */
function isResumeRetryable(message: string): boolean {
  return message.includes("could not resume the session");
}

// --- IO seam (browser by default, injectable for tests) --------------------

const WS_OPEN = 1; // WebSocket.OPEN

export interface WsLike {
  readyState: number;
  addEventListener(type: "open" | "close" | "error" | "message", cb: (ev: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface WsEnv {
  wsUrl: () => string;
  createSocket: (url: string) => WsLike;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  isHidden: () => boolean;
  /** Subscribe to page visibility changes; returns an unsubscribe function. */
  onVisibilityChange: (cb: () => void) => () => void;
  random: () => number;
}

function browserWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

export function browserEnv(): WsEnv {
  return {
    wsUrl: browserWsUrl,
    createSocket: (url) => new WebSocket(url) as unknown as WsLike,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    isHidden: () => typeof document !== "undefined" && document.hidden,
    onVisibilityChange: (cb) => {
      if (typeof document === "undefined") return () => {};
      document.addEventListener("visibilitychange", cb);
      return () => document.removeEventListener("visibilitychange", cb);
    },
    random: () => Math.random(),
  };
}

/** `helloSessionId`, if given, resumes that session as soon as the socket opens. */
export function connect(
  onMsg: (m: BridgeMsg) => void,
  onState: (s: ConnState) => void,
  helloSessionId?: string,
  env: WsEnv = browserEnv(),
): Conn {
  let ws: WsLike | null = null;
  let attempt = 0; // consecutive-failure counter, shared by socket reconnects and hello-retries
  let manualClose = false;
  let timer: unknown = null;
  let pendingAction: (() => void) | null = null;
  let pendingWhileHidden = false;
  let dropHandled = true; // guards against a socket's close+error both firing
  let lastHelloSessionId = helloSessionId;

  const raw = (obj: unknown) => {
    if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(obj));
  };

  function clearTimer() {
    if (timer !== null) { env.clearTimer(timer); timer = null; }
  }

  function armTimer() {
    clearTimer();
    const delay = withJitter(backoffBaseMs(attempt), env.random);
    timer = env.setTimer(() => { timer = null; fireRetry(); }, delay);
  }

  function fireRetry() {
    pendingWhileHidden = false;
    const action = pendingAction;
    pendingAction = null;
    action?.();
  }

  /** Bounded retry: shared by socket reconnects and #11 hello-retries — never a tight loop. */
  function scheduleRetry(action: () => void) {
    if (manualClose) return;
    attempt += 1;
    pendingAction = action;
    if (attempt > RECONNECT_MAX_ATTEMPTS) {
      onState("offline"); // dormant: no more timers until a manual reconnect()
      pendingWhileHidden = false;
      return;
    }
    onState("reconnecting");
    if (env.isHidden()) { pendingWhileHidden = true; return; } // don't hammer a hidden tab
    armTimer();
  }

  function retryHello() {
    raw({ type: "hello", sessionId: lastHelloSessionId });
  }

  function openSocket() {
    if (manualClose) return;
    dropHandled = false;
    onState(attempt === 0 ? "connecting" : "reconnecting");
    const socket = env.createSocket(env.wsUrl());
    ws = socket;

    socket.addEventListener("open", () => {
      attempt = 0;
      onState("open");
      raw({ type: "hello", sessionId: lastHelloSessionId });
    });
    const onDrop = () => {
      if (dropHandled) return;
      dropHandled = true;
      scheduleRetry(openSocket);
    };
    socket.addEventListener("close", onDrop);
    socket.addEventListener("error", onDrop);
    socket.addEventListener("message", (ev) => {
      let m: BridgeMsg;
      try { m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); }
      catch { return; }
      if (m.type === "session") {
        lastHelloSessionId = m.sessionId;
        attempt = 0;
        onState("open");
      } else if (m.type === "error" && isResumeRetryable(m.message)) {
        scheduleRetry(retryHello); // same bounded backoff, socket stays open
      }
      onMsg(m);
    });
  }

  const unsubscribeVisibility = env.onVisibilityChange(() => {
    if (env.isHidden()) {
      if (timer !== null) { clearTimer(); pendingWhileHidden = true; } // pause; don't hammer
      return;
    }
    if (pendingWhileHidden) { clearTimer(); fireRetry(); } // try once, right away, on wake
  });

  openSocket();

  return {
    send(text: string) { raw({ type: "send", text }); },
    stop() { raw({ type: "stop" }); },
    hello(sessionId?: string) { lastHelloSessionId = sessionId; raw({ type: "hello", sessionId }); },
    newSession() { raw({ type: "new_session" }); },
    listSessions() { raw({ type: "list_sessions" }); },
    listModels() { raw({ type: "list_models" }); },
    setModel(provider: string, modelId: string) { raw({ type: "set_model", provider, modelId }); },
    connectProvider(provider: string, apiKey: string) { raw({ type: "connect_provider", provider, apiKey }); },
    connectCustomProvider(spec: CustomProviderSpec) { raw({ type: "connect_custom_provider", spec }); },
    listWorkspaces() { raw({ type: "list_workspaces" }); },
    setWorkspace(workspaceId: string) { raw({ type: "set_workspace", workspaceId }); },
    createWorkspace(name: string) { raw({ type: "create_workspace", name }); },
    listModelPrompts() { raw({ type: "list_model_prompts" }); },
    setModelPrompt(provider: string, modelId: string, prompt: string) {
      raw({ type: "set_model_prompt", provider, modelId, prompt });
    },
    reconnect() {
      manualClose = false;
      attempt = 0;
      pendingWhileHidden = false;
      clearTimer();
      openSocket();
    },
    close() {
      manualClose = true;
      clearTimer();
      unsubscribeVisibility();
      try { ws?.close(); } catch { /* already closing */ }
    },
  };
}
