import { useEffect, useRef, useReducer, useState } from "react";
import { reducer, initialState, type ToolCall } from "./reducer.ts";
import { connect, type Conn, type ConnState, type SessionSummary, type ModelSummary, type ModelPromptMap, type WorkspaceSummary } from "./ws.ts";
import { sheetBody } from "./sheet-state.ts";
import { modelLabel } from "./model-label.ts";
import { steerReducer, initialSteer, nextHeld, isQueued, serializeHeld, parseHeld,
         type SteerState } from "./steering.ts";
import { createPiTranslator, isPiEvent, type PiEvent } from "./pi-events.ts";
import { statusReducer, initialStatus, readout, routeStatusFrame, STATUS_ID, type StatusAsk } from "./status-bar.ts";

/**
 * Lazy initialiser for the held-draft queue. Storage can throw outright (a
 * browser set to block site data), so a failed restore is an empty queue and
 * never a blank app.
 */
function restoreHeld(): SteerState {
  try {
    return { ...initialSteer, held: parseHeld(localStorage.getItem(HELD_KEY)) };
  } catch {
    return initialSteer;
  }
}

const TOOL_ICON: Record<ToolCall["status"], string> = { running: "", ok: "✓", error: "✗", stopped: "■" };
const SESSION_KEY = "grtbx:sessionId";
/** Held drafts outlive a reload because the phone drops its socket routinely
 *  — backgrounding, a screen lock, a wifi handover (#95, §5). */
const HELD_KEY = "grtbx:heldDrafts";
/** How long a press on send must last to mean "steer" rather than "hold". */
const STEER_HOLD_MS = 500;

// Providers offered in the picker (issue #31, ADR-011; widened in #39). This is
// a CONVENIENCE LIST, not an allowlist — the field accepts any provider id Pi
// knows, so anything in Pi's docs/providers.md table works whether or not it is
// named here. Keys go into Pi's own auth.json, so a key set from the phone and a
// key set with `pi` on a terminal are the same key.
const SUGGESTED_PROVIDERS: Array<{ id: string; label: string }> = [
  { id: "google", label: "Google Gemini" },
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "groq", label: "Groq" },
  { id: "mistral", label: "Mistral" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "xai", label: "xAI" },
  { id: "together", label: "Together AI" },
  { id: "fireworks", label: "Fireworks" },
  { id: "cerebras", label: "Cerebras" },
  { id: "nvidia", label: "NVIDIA NIM" },
  { id: "huggingface", label: "Hugging Face" },
  { id: "vercel-ai-gateway", label: "Vercel AI Gateway" },
];

function formatArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  const s = typeof args === "string" ? args : JSON.stringify(args);
  return s.length > 140 ? s.slice(0, 140) + "…" : s;
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  // The status bar (#72) — Pi's own terminal footer, reproduced rather than
  // redesigned. Its own reducer: the chat state machine is about messages, and
  // none of these numbers come from one.
  const [status, dispatchStatus] = useReducer(statusReducer, initialStatus);
  const [barOpen, setBarOpen] = useState(false);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [draft, setDraft] = useState("");
  const [steer, dispatchSteer] = useReducer(steerReducer, initialSteer, restoreHeld);
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null); // null = never loaded
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [models, setModels] = useState<ModelSummary[] | null>(null); // null = never loaded
  const [currentModel, setCurrentModel] = useState<{ provider: string; modelId: string } | undefined>();
  const [connectProviderChoice, setConnectProviderChoice] = useState(SUGGESTED_PROVIDERS[0].id);
  const [connectKey, setConnectKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  // Custom endpoint form (issue #34) — collapsed by default so the common case
  // (a first-party key) stays a two-field job on a phone.
  const [customOpen, setCustomOpen] = useState(false);
  const [customId, setCustomId] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customModelId, setCustomModelId] = useState("");
  const [customKey, setCustomKey] = useState("");

  /**
   * Workspaces (issue #50). The picker hangs off the "New" button rather than a
   * sixth header button: a new conversation always happens SOMEWHERE, and on a
   * phone the header has no room left. Picking the workspace you are already in
   * is just a new chat; picking another starts one there.
   */
  const [workspaceSheetOpen, setWorkspaceSheetOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null); // null = never loaded
  const [currentWorkspace, setCurrentWorkspace] = useState<string | undefined>();
  const [projectName, setProjectName] = useState("");

  // Per-model system prompts (issue #42). `prompts` is null until the bridge
  // answers, so the sheet can say "loading" rather than "none set".
  const [promptSheetOpen, setPromptSheetOpen] = useState(false);
  const [prompts, setPrompts] = useState<ModelPromptMap | null>(null);
  const [promptDraft, setPromptDraft] = useState("");
  const [promptSaved, setPromptSaved] = useState(false);
  const connRef = useRef<Conn | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | undefined>(localStorage.getItem(SESSION_KEY) ?? undefined);
  // Sheet loads awaiting a response; an `error` frame closes that sheet so the
  // surfaced error bubble is visible, never hidden behind a stuck "Loading…".
  const pendingSheetLoad = useRef({ history: false, models: false, prompts: false, workspaces: false });
  // A create in flight, by name. The bridge acks a create with the same
  // `workspaces` frame as a plain list, so this is what tells them apart — and
  // what lets "create a project" land the user INSIDE it rather than back at a
  // list with one more row.
  const pendingCreate = useRef<string | null>(null);
  // The `session` frame names the workspace by ID, not by name. Without the
  // list, the header can only show `workspaces/notes` where it means `notes` —
  // so fetch it once, eagerly. It is bridge-local (no Pi round-trip, ADR-007's
  // rule for the model picker applies), and the header is on screen always.
  const workspacesRequested = useRef(false);
  // Same for the model. The header said "Model" on every page load — not
  // because none was selected, but because the client only ever asked for the
  // list when the picker was opened, and `current` rides on that frame. A
  // header that cannot name the model it is about is a lie on every cold load,
  // and it defeated the acceptance drive's "don't touch the owner's model"
  // guard on 2026-08-27. `list_models` is answered from config with no Pi
  // round-trip (ADR-007), so asking early costs nothing.
  const modelsRequested = useRef(false);
  // A save is in flight: the bridge answers a save and a plain list with the
  // same `model_prompts` frame, so only this tells them apart.
  const pendingPromptSave = useRef(false);
  // Which (provider, model) the editor's text was seeded from — see the effect.
  const seededFor = useRef<string | null>(null);
  // ADR-015: once the bridge answers `hello` with `relaying`, Pi's own events
  // are the transcript and the bridge's translated frames stop, so this holds
  // the state `agent_end` carries across to `agent_settled` (#77).
  const piTranslator = useRef(createPiTranslator());
  const relayingRef = useRef(false);
  // The same fact as `relayingRef`, in a form the render can read. The ref is
  // what the socket callback sees (it captures the first render); this is what
  // decides whether the bar is on screen at all.
  const [relaying, setRelaying] = useState(false);
  const statusSeq = useRef(0);
  const heldSeq = useRef(0);
  const steerSeq = useRef(0);
  const pressTimer = useRef<number | null>(null);
  const steerFired = useRef(false);
  const wasStreaming = useRef(false);
  // The routing needs the current cursor, and the socket callback captures the
  // first render — so the cursor lives in a ref that an effect keeps in step
  // with the reducer's copy.
  const cursorRef = useRef<string | undefined>(undefined);

  function handleConnState(s: ConnState) {
    setConn(s);
    // A drop mid-turn stops any local spinner; the reconnect's replayed
    // transcript is the truth (issue #5) — this is a no-op when nothing's streaming.
    if (s !== "open") dispatch({ t: "disconnected" });
  }

  /** One of Pi's own read commands, tagged so its answer comes back to us. */
  function askPi(ask: StatusAsk) {
    if (!relayingRef.current) return;
    connRef.current?.pi({ ...ask, id: `${STATUS_ID}${statusSeq.current++}` });
  }

  /**
   * The readout's feed (#72). Pi's events and Pi's responses both, which exist
   * only on a relaying socket — so on a client that never declares the seam
   * this is inert and the bar never appears, which is the pre-relay path
   * ADR-014 requires stays intact.
   *
   * Nothing here is on a timer: both reads ride the turn-lifecycle events that
   * can move the numbers, so at rest the bar is static and the Sprite sees
   * nothing, which is what keeps ADR-010's pause load-bearing.
   * `routeStatusFrame` owns which frame means what — including when a request
   * is safe to send at all, and which cursor it carries.
   */
  function handleStatusFrame(f: { type?: string; [k: string]: unknown }, couldResume: boolean) {
    const { actions, ask } = routeStatusFrame(f, { couldResume, cursor: cursorRef.current });
    for (const a of actions) dispatchStatus(a);
    for (const c of ask) askPi(c);
  }

  function open() {
    connRef.current?.close();
    connRef.current = connect(
      (m) => {
        // The bar reads frames the transcript has no case for — `entry_appended`,
        // `compaction_end`, Pi's responses — so it looks first and never returns.
        // `sessionIdRef` is read here, before the `session` branch overwrites
        // it: whether this socket's `hello` named a session decides whether a
        // resume could still be in flight, and so whether a request is safe.
        handleStatusFrame(m as unknown as { type?: string; [k: string]: unknown },
                          sessionIdRef.current !== undefined);
        // A relaying socket gets Pi's events verbatim and none of the bridge's
        // translations, so these ARE the transcript now (ADR-015 clause 5).
        // Pi's own steering queue (#95). It crosses the relay untranslated: no
        // reducer action, because nothing in the transcript changes shape — it
        // only decides which user bubbles are still greyed.
        const raw = m as unknown as { type?: unknown; steering?: unknown };
        if (raw.type === "queue_update") {
          dispatchSteer({ t: "queue_update", steering: Array.isArray(raw.steering) ? (raw.steering as string[]) : [] });
          return;
        }
        if (isPiEvent(m as { type?: unknown })) {
          for (const a of piTranslator.current.handle(m as unknown as PiEvent)) dispatch(a);
          return;
        }
        if (m.type === "seam") { relayingRef.current = m.relaying; setRelaying(m.relaying); return; }
        if (m.type === "token") dispatch({ t: "token", delta: m.delta });
        else if (m.type === "done") dispatch({ t: "done" });
        else if (m.type === "error") {
          if (pendingSheetLoad.current.history) { pendingSheetLoad.current.history = false; setHistoryOpen(false); }
          if (pendingSheetLoad.current.models) { pendingSheetLoad.current.models = false; setModelSheetOpen(false); }
          if (pendingSheetLoad.current.prompts) { pendingSheetLoad.current.prompts = false; setPromptSheetOpen(false); }
          if (pendingSheetLoad.current.workspaces) { pendingSheetLoad.current.workspaces = false; setWorkspaceSheetOpen(false); }
          pendingCreate.current = null; // a failed create must not silently enter something later
          setConnecting(false); // a connect_provider failure surfaces here too (issue #31)
          dispatch({ t: "error", message: m.message });
        }
        else if (m.type === "tool_start") dispatch({ t: "tool_start", toolCallId: m.toolCallId, name: m.name, args: m.args });
        else if (m.type === "tool_update") dispatch({ t: "tool_update", toolCallId: m.toolCallId, output: m.output });
        else if (m.type === "tool_end") dispatch({ t: "tool_end", toolCallId: m.toolCallId, ok: m.ok, output: m.output });
        else if (m.type === "session") {
          sessionIdRef.current = m.sessionId;
          localStorage.setItem(SESSION_KEY, m.sessionId);
          // A resume returns to the workspace it was started in, so the bridge
          // is the authority on where we are — never local state (#50).
          if (m.workspaceId) setCurrentWorkspace(m.workspaceId);
          if (!workspacesRequested.current) {
            workspacesRequested.current = true;
            connRef.current?.listWorkspaces();
          }
          if (!modelsRequested.current) {
            modelsRequested.current = true;
            connRef.current?.listModels();
          }
          // Pi's queue belongs to the session that had it. Held drafts are the
          // user's own words and deliberately survive the switch.
          dispatchSteer({ t: "reset" });
          dispatch({ t: "load_session", turns: m.turns });
        } else if (m.type === "workspaces") {
          pendingSheetLoad.current.workspaces = false;
          setWorkspaces(m.workspaces);
          if (m.current) setCurrentWorkspace(m.current);
          const created = pendingCreate.current;
          if (created != null) {
            pendingCreate.current = null;
            const match = m.workspaces.find((w) => w.kind === "project" && w.name === created);
            setProjectName("");
            // Creating a project means going to work in it.
            if (match) { setWorkspaceSheetOpen(false); connRef.current?.setWorkspace(match.id); }
          }
        } else if (m.type === "sessions") {
          pendingSheetLoad.current.history = false;
          setSessions(m.sessions);
        } else if (m.type === "model_prompts") {
          pendingSheetLoad.current.prompts = false;
          setPrompts(m.prompts);
          // "Saved" must mean the user saved, not merely that the map arrived —
          // otherwise opening the sheet claims a save that never happened.
          if (pendingPromptSave.current) {
            pendingPromptSave.current = false;
            setPromptSaved(true);
          }
        } else if (m.type === "models") {
          pendingSheetLoad.current.models = false;
          // A connect_provider's success is signalled by this same frame
          // (issue #31 — no dedicated ack); clear the connect form either way.
          setConnecting(false);
          setConnectKey("");
          // Same for a custom endpoint (#34): collapse the form once the
          // catalog comes back carrying it.
          setCustomOpen(false);
          setCustomId("");
          setCustomBaseUrl("");
          setCustomModelId("");
          setCustomKey("");
          setModels(m.models);
          // Pi's footer names the provider only when there is more than one to
          // tell apart, and the catalog already spans every connected one (#39).
          dispatchStatus({ t: "providers", count: new Set(m.models.map((x) => x.provider)).size });
          if (m.current) setCurrentModel(m.current);
        } else if (m.type === "model_set") {
          setCurrentModel({ provider: m.provider, modelId: m.modelId });
        }
      },
      handleConnState,
      sessionIdRef.current,
    );
  }

  useEffect(() => { cursorRef.current = status.cursor; }, [status.cursor]);

  // Held drafts survive a reload (#95). Storage can throw where site data is
  // blocked, so a failed write is a lost convenience, never a lost turn.
  useEffect(() => {
    try {
      if (steer.held.length) localStorage.setItem(HELD_KEY, serializeHeld(steer.held));
      else localStorage.removeItem(HELD_KEY);
    } catch { /* a draft that cannot be persisted is still usable this session */ }
  }, [steer.held]);

  /**
   * A settling run flushes ONE held draft (#95, §5).
   *
   * One, not all: sending the second while the first is in flight would put it
   * straight back into the hold, and §5 values keeping the rest editable over
   * emptying the queue fast. So each settle takes the oldest and the others
   * wait their turn, still editable.
   */
  useEffect(() => {
    const settling = wasStreaming.current && !state.streaming;
    wasStreaming.current = state.streaming;
    if (!settling) return;
    if (conn !== "open") return; // the drafts keep; they flush on the next settle
    const next = nextHeld(steer);
    if (!next) return;
    dispatchSteer({ t: "unhold", id: next.id });
    dispatch({ t: "send", text: next.text });
    connRef.current?.send(next.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.streaming, conn]);

  useEffect(() => {
    open();
    return () => connRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keep the newest message in view
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [state.messages]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || state.streaming) return;
    if (conn !== "open") {
      // Never a silent drop: a send attempted while disconnected fails visibly
      // and immediately (the Send button is also disabled for this — belt and
      // braces against the Enter-key path and any state race).
      dispatch({ t: "error", message: "You're offline — message not sent." });
      return;
    }
    dispatch({ t: "send", text });
    connRef.current?.send(text);
    setDraft("");
  }

  function stop() {
    connRef.current?.stop();
  }

  /**
   * Tap send while a run is live (#95, §5).
   *
   * The message is kept HERE, not sent to Pi, which is the whole point: a
   * draft this side of the seam is still editable and still removable, and
   * Pi's queue offers neither. It leaves as an ordinary prompt once the run
   * settles.
   */
  function holdDraft() {
    const text = draft.trim();
    if (!text) return;
    dispatchSteer({ t: "hold", id: `h${heldSeq.current++}`, text });
    setDraft("");
  }

  /** A held draft goes back to the composer to be edited — the same gesture removes it. */
  function editHeld(id: string, text: string) {
    dispatchSteer({ t: "unhold", id });
    setDraft((d) => (d.trim() ? `${d.replace(/\s+$/, "")}\n${text}` : text));
  }

  /**
   * Steer: the message reaches Pi at once and the model reads it at the next
   * tool boundary, so work already in flight is kept rather than thrown away.
   *
   * Irreversible, and deliberately so — Pi's RPC has no `clear_queue`, only its
   * core does, so nothing can take this back. That is why it is the long press
   * and the reversible hold is the tap.
   */
  function steerNow(text: string) {
    const t = text.trim();
    if (!t) return;
    if (!requireConn()) return;
    // The bubble appears immediately and greys until `queue_update` stops
    // listing it. Without this the message would be invisible until Pi picked
    // it up, which on a slow turn is a long time to wonder whether it sent.
    dispatch({ t: "steer", text: t });
    connRef.current?.pi({ type: "steer", id: `steer${steerSeq.current++}`, message: t });
  }

  /** Long-press steers, a tap holds. Pointer events so a mouse hold works too. */
  function beginSendPress() {
    steerFired.current = false;
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      steerFired.current = true;
      const text = draft.trim();
      if (!text) return;
      steerNow(text);
      setDraft("");
    }, STEER_HOLD_MS);
  }

  function endSendPress(fire: boolean) {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    // The long press already acted; releasing must not also hold the draft.
    if (fire && !steerFired.current) holdDraft();
    steerFired.current = false;
  }

  /** ws.ts drops frames silently when the socket isn't open — fail visibly instead (issue #6). */
  function requireConn(): boolean {
    if (conn === "open") return true;
    dispatch({ t: "error", message: "You're offline — reconnect and try again." });
    return false;
  }

  /**
   * The overflow menu (issue #92).
   *
   * Holds nothing of its own — every item opens one of the sheets that used to
   * have its own header button. It closes as it hands over, so two overlays are
   * never stacked.
   */
  function openMenu() {
    setMenuOpen(true);
  }

  function closeMenu() {
    setMenuOpen(false);
  }

  function fromMenu(open: () => void) {
    return () => {
      closeMenu();
      open();
    };
  }

  function openHistory() {
    setHistoryOpen(true);
    if (conn === "open") {
      pendingSheetLoad.current.history = true;
      connRef.current?.listSessions();
    }
  }

  function closeHistory() {
    pendingSheetLoad.current.history = false;
    setHistoryOpen(false);
  }

  function selectSession(id: string) {
    closeHistory();
    if (!requireConn()) return;
    connRef.current?.hello(id);
  }

  /**
   * The workspace picker (issue #50).
   *
   * Opened by "New", because starting a conversation and choosing where it runs
   * are the same decision. The list is re-requested on every open rather than
   * cached: the agent can `mkdir` a project itself mid-conversation, and a
   * stale picker would hide it.
   */
  function openWorkspaces() {
    setWorkspaceSheetOpen(true);
    if (conn === "open") {
      pendingSheetLoad.current.workspaces = true;
      connRef.current?.listWorkspaces();
    }
  }

  function closeWorkspaces() {
    pendingSheetLoad.current.workspaces = false;
    pendingCreate.current = null;
    setWorkspaceSheetOpen(false);
  }

  /** Same workspace ⇒ just a new chat; a different one ⇒ a new chat over there. */
  function selectWorkspace(w: WorkspaceSummary) {
    closeWorkspaces();
    if (!requireConn()) return;
    if (w.id === currentWorkspace) connRef.current?.newSession();
    else connRef.current?.setWorkspace(w.id);
  }

  function submitProject(e: React.FormEvent) {
    e.preventDefault();
    const name = projectName.trim();
    if (!name || pendingCreate.current) return;
    if (!requireConn()) return;
    pendingCreate.current = name;
    connRef.current?.createWorkspace(name);
  }

  function openModelPicker() {
    setModelSheetOpen(true);
    if (conn === "open") {
      pendingSheetLoad.current.models = true;
      connRef.current?.listModels();
    }
  }

  function closeModelPicker() {
    pendingSheetLoad.current.models = false;
    setModelSheetOpen(false);
  }

  function selectModel(m: ModelSummary) {
    closeModelPicker();
    if (!requireConn()) return;
    connRef.current?.setModel(m.provider, m.id);
  }

  /**
   * Per-model system prompts (issue #42).
   *
   * Edits the framing for the model that is CURRENTLY selected — the prompt is
   * a property of a model, and the picker is how you choose one. There is no
   * model-agnostic prompt on purpose: a self-hosted model and a frontier model
   * wanting the same framing is the uncommon case.
   */
  function openPromptEditor() {
    setPromptSheetOpen(true);
    setPromptSaved(false);
    if (conn === "open") {
      pendingSheetLoad.current.prompts = true;
      connRef.current?.listModelPrompts();
    }
  }

  function closePromptEditor() {
    pendingSheetLoad.current.prompts = false;
    pendingPromptSave.current = false;
    seededFor.current = null; // reopening loads the stored text afresh
    setPromptSheetOpen(false);
  }

  function submitPrompt(e: React.FormEvent) {
    e.preventDefault();
    if (!currentModel) return;
    if (!requireConn()) return;
    // Sent untrimmed; the bridge decides that blank means "clear".
    pendingPromptSave.current = true;
    connRef.current?.setModelPrompt(currentModel.provider, currentModel.modelId, promptDraft);
  }

  /** BYO first-party provider key (issue #31, ADR-011). */
  function submitConnect(e: React.FormEvent) {
    e.preventDefault();
    const apiKey = connectKey.trim();
    if (!apiKey || connecting) return;
    if (!requireConn()) return;
    setConnecting(true);
    connRef.current?.connectProvider(connectProviderChoice, apiKey);
  }

  /**
   * BYO custom / self-hosted endpoint (issue #34, ADR-011).
   *
   * The key is sent through untouched and resolved by Pi: a plain key is used
   * literally, while `$SOME_VAR` reads that variable from the agent's
   * environment. One box covers both without a mode switch.
   */
  function submitCustomConnect(e: React.FormEvent) {
    e.preventDefault();
    const id = customId.trim();
    const baseUrl = customBaseUrl.trim();
    const modelId = customModelId.trim();
    const apiKey = customKey.trim();
    if (!id || !baseUrl || !modelId || !apiKey || connecting) return;
    if (!requireConn()) return;
    setConnecting(true);
    connRef.current?.connectCustomProvider({ id, baseUrl, apiKey, models: [{ id: modelId }] });
  }

  // A sheet opened while disconnected shows "waiting"; when the connection
  // comes back, load it then — no dead-end, no manual retry needed.
  useEffect(() => {
    if (conn !== "open") return;
    if (historyOpen && !pendingSheetLoad.current.history) {
      pendingSheetLoad.current.history = true;
      connRef.current?.listSessions();
    }
    if (promptSheetOpen && !pendingSheetLoad.current.prompts) {
      pendingSheetLoad.current.prompts = true;
      connRef.current?.listModelPrompts();
    }
    if (modelSheetOpen && !pendingSheetLoad.current.models) {
      pendingSheetLoad.current.models = true;
      connRef.current?.listModels();
    }
    if (workspaceSheetOpen && !pendingSheetLoad.current.workspaces) {
      pendingSheetLoad.current.workspaces = true;
      connRef.current?.listWorkspaces();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn]);

  /**
   * Seed the editor from the stored map ONCE per (open, model) — never on every
   * `prompts` update.
   *
   * The naive version re-seeded whenever a `model_prompts` frame arrived, which
   * silently wiped whatever the user was mid-way through typing: open the
   * sheet, start typing, let the sheet's own load land, and the text is gone.
   * Caught by the driver as a flaky "clear" that sometimes reverted.
   */
  useEffect(() => {
    if (!promptSheetOpen || prompts == null || currentModel == null) return;
    const key = `${currentModel.provider}\u0000${currentModel.modelId}`;
    if (seededFor.current === key) return;
    seededFor.current = key;
    setPromptDraft(prompts[currentModel.provider]?.[currentModel.modelId] ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptSheetOpen, prompts, currentModel?.provider, currentModel?.modelId]);

  const connLabel =
    conn === "open"
      ? "connected"
      : conn === "connecting"
        ? "connecting…"
        : conn === "reconnecting"
          ? "reconnecting…"
          : "offline";

  const currentModelLabel = modelLabel(
    models?.find((m) => m.provider === currentModel?.provider && m.id === currentModel?.modelId)?.name,
    currentModel?.modelId,
  );

  // "offline" is dormant (auto-retry exhausted) — reconnecting needs the banner
  // behind the sheet, so point at it; otherwise a retry is already in flight.
  const waitingText =
    conn === "offline" ? "Offline — close this sheet and tap Reconnect." : "Waiting for connection…";
  const historyBody = sheetBody(conn, sessions);
  const modelsBody = sheetBody(conn, models);
  const workspacesBody = sheetBody(conn, workspaces);
  // Before the first `session` frame there is nothing truthful to show, so the
  // brand stands alone rather than guessing "Home".
  const currentWorkspaceLabel =
    workspaces?.find((w) => w.id === currentWorkspace)?.name ?? currentWorkspace;

  const empty = state.messages.length === 0;

  // The bar's two duties in one row (#72): while a run is live the strip shows
  // the run, at rest it shows the readout, and the readout is right-aligned in
  // both so the row holds still instead of appearing and disappearing.
  const bar = readout(status);
  const runLabel = (() => {
    if (!state.streaming) return undefined;
    let last: typeof state.messages[number] | undefined;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === "assistant") { last = state.messages[i]; break; }
    }
    const running = last?.tools?.filter((t) => t.status === "running") ?? [];
    if (running.length === 1) return running[0].name;
    if (running.length > 1) return `${running.length} tools`;
    return "replying";
  })();

  return (
    <div className="app">
      <header className="hdr">
        <span className="brand">
          grtbx
          {currentWorkspaceLabel && (
            <span className="brand__workspace" aria-label="current workspace">{currentWorkspaceLabel}</span>
          )}
        </span>
        <div className="hdr__actions">
          <button type="button" className="hdr__btn hdr__btn--model" onClick={openModelPicker} aria-label="model picker">{currentModelLabel}</button>
          {/* Prompt, History and New live behind this (#92). Measured at 320px
              the four labelled buttons plus the word "connected" needed 289px of
              a 238px row, so something had to go behind a menu; the model stayed
              out because it is the only one whose VALUE the header reports. */}
          <button
            type="button"
            className="hdr__btn hdr__btn--more"
            onClick={openMenu}
            aria-label="more actions"
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
          >
            <span aria-hidden="true">⋯</span>
          </button>
          {/* A dot, not a word: "connected" cost 63px to say nothing is wrong.
              The state still reaches a screen reader through the live region,
              and "offline" additionally raises the banner below. */}
          <span className={`conn conn--${conn}`} role="status" aria-live="polite">
            <span className="conn__dot" aria-hidden="true" />
            <span className="conn__text">{connLabel}</span>
          </span>
        </div>
      </header>

      {conn === "offline" && (
        <div className="banner" role="alert">
          <span>Connection lost.</span>
          <button type="button" onClick={() => connRef.current?.reconnect()}>Reconnect</button>
        </div>
      )}

      {menuOpen && (
        <div className="sheet" role="dialog" aria-label="more actions">
          <div className="sheet__panel">
            <div className="sheet__hdr">
              <span>Menu</span>
              <button type="button" className="sheet__close" onClick={closeMenu} aria-label="close">✕</button>
            </div>
            <div className="sheet__list">
              <button type="button" className="sheet__item" onClick={fromMenu(openPromptEditor)} aria-label="system prompt" aria-describedby="menu-prompt-desc">
                <span className="sheet__item-preview">Prompt</span>
                <span className="sheet__item-time" id="menu-prompt-desc">Extra instructions for {currentModelLabel}</span>
              </button>
              <button type="button" className="sheet__item" onClick={fromMenu(openHistory)} aria-label="session history" aria-describedby="menu-history-desc">
                <span className="sheet__item-preview">History</span>
                <span className="sheet__item-time" id="menu-history-desc">Reopen a past session</span>
              </button>
              <button type="button" className="sheet__item" onClick={fromMenu(openWorkspaces)} aria-label="new session" aria-describedby="menu-new-desc">
                <span className="sheet__item-preview">New</span>
                <span className="sheet__item-time" id="menu-new-desc">Start a chat, and choose where it runs</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {historyOpen && (
        <div className="sheet" role="dialog" aria-label="session history">
          <div className="sheet__panel">
            <div className="sheet__hdr">
              <span>History</span>
              <button type="button" className="sheet__close" onClick={closeHistory} aria-label="close">✕</button>
            </div>
            <div className="sheet__list">
              {historyBody === "waiting" ? (
                <p className="sheet__empty">{waitingText}</p>
              ) : historyBody === "loading" ? (
                <p className="sheet__empty">Loading sessions…</p>
              ) : historyBody === "empty" ? (
                <p className="sheet__empty">No past sessions yet.</p>
              ) : (
                sessions!.map((s) => (
                  <button type="button" key={s.id} className="sheet__item" onClick={() => selectSession(s.id)}>
                    <span className="sheet__item-preview">{s.preview}</span>
                    <span className="sheet__item-time">{new Date(s.updatedAt).toLocaleString()}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {workspaceSheetOpen && (
        <div className="sheet" role="dialog" aria-label="workspace picker">
          <div className="sheet__panel">
            <div className="sheet__hdr">
              <span>New chat in…</span>
              <button type="button" className="sheet__close" onClick={closeWorkspaces} aria-label="close">✕</button>
            </div>
            <div className="sheet__list">
              {workspacesBody === "waiting" ? (
                <p className="sheet__empty">{waitingText}</p>
              ) : workspacesBody === "loading" ? (
                <p className="sheet__empty">Loading workspaces…</p>
              ) : workspacesBody === "empty" ? (
                <p className="sheet__empty">No workspaces available.</p>
              ) : (
                workspaces!.map((w) => {
                  const isCurrent = w.id === currentWorkspace;
                  return (
                    <button
                      type="button"
                      key={w.id}
                      className={`sheet__item${isCurrent ? " sheet__item--current" : ""}`}
                      onClick={() => selectWorkspace(w)}
                    >
                      <span className="sheet__item-preview">{w.name}</span>
                      <span className="sheet__item-time">{isCurrent ? `${w.path ?? "here"} · current` : w.path ?? ""}</span>
                    </button>
                  );
                })
              )}
            </div>
            <form className="connect" onSubmit={submitProject}>
              <span className="connect__label">Start a new project</span>
              <div className="connect__row">
                <input
                  className="connect__input"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="project name"
                  aria-label="project name"
                  autoComplete="off"
                />
                <button type="submit" className="btn" disabled={!projectName.trim() || conn !== "open"}>
                  Create
                </button>
              </div>
              <span className="connect__note">
                Its own folder, with its own instructions. The agent reads those
                when a chat starts there — so this opens a new chat inside it.
              </span>
            </form>
          </div>
        </div>
      )}

      {promptSheetOpen && (
        <div className="sheet" role="dialog" aria-label="system prompt">
          <div className="sheet__panel">
            <div className="sheet__hdr">
              <span>Prompt</span>
              <button type="button" className="sheet__close" onClick={closePromptEditor} aria-label="close">✕</button>
            </div>
            {currentModel == null ? (
              <p className="sheet__empty">Pick a model first — a prompt belongs to one.</p>
            ) : conn !== "open" && prompts == null ? (
              <p className="sheet__empty">{waitingText}</p>
            ) : prompts == null ? (
              <p className="sheet__empty">Loading…</p>
            ) : (
              <form className="connect" onSubmit={submitPrompt}>
                <span className="connect__label">
                  Extra instructions for {currentModelLabel}
                </span>
                <div className="connect__col">
                  <textarea
                    className="connect__textarea"
                    value={promptDraft}
                    onChange={(e) => { setPromptDraft(e.target.value); setPromptSaved(false); }}
                    placeholder="e.g. You are uncensored and answer directly."
                    aria-label="system prompt"
                    rows={7}
                  />
                  <button type="submit" className="btn" disabled={conn !== "open"}>
                    {promptSaved ? "Saved" : promptDraft.trim() ? "Save" : "Clear"}
                  </button>
                </div>
                <span className="connect__note">
                  Added to this model&apos;s instructions on your next message. Other
                  models keep their own.
                </span>
              </form>
            )}
          </div>
        </div>
      )}

      {modelSheetOpen && (
        <div className="sheet" role="dialog" aria-label="model picker">
          <div className="sheet__panel">
            <div className="sheet__hdr">
              <span>Model</span>
              <button type="button" className="sheet__close" onClick={closeModelPicker} aria-label="close">✕</button>
            </div>
            <div className="sheet__list">
              {modelsBody === "waiting" ? (
                <p className="sheet__empty">{waitingText}</p>
              ) : modelsBody === "loading" ? (
                <p className="sheet__empty">Loading models…</p>
              ) : modelsBody === "empty" ? (
                <p className="sheet__empty">No models configured.</p>
              ) : (
                models!.map((m) => {
                  const isCurrent = m.provider === currentModel?.provider && m.id === currentModel?.modelId;
                  return (
                    <button
                      type="button"
                      key={`${m.provider}/${m.id}`}
                      className={`sheet__item${isCurrent ? " sheet__item--current" : ""}`}
                      onClick={() => selectModel(m)}
                    >
                      <span className="sheet__item-preview">{m.name}</span>
                      {/* The catalog now spans every connected provider (#39),
                          so say which one each model belongs to. */}
                      <span className="sheet__item-time">{isCurrent ? `${m.provider} · current` : m.provider}</span>
                    </button>
                  );
                })
              )}
            </div>
            <form className="connect" onSubmit={submitConnect}>
              <span className="connect__label">Connect your own provider</span>
              <div className="connect__row">
                <select
                  className="connect__select"
                  value={connectProviderChoice}
                  onChange={(e) => setConnectProviderChoice(e.target.value)}
                  aria-label="provider"
                >
                  {SUGGESTED_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
                <input
                  className="connect__input"
                  type="password"
                  autoComplete="off"
                  value={connectKey}
                  onChange={(e) => setConnectKey(e.target.value)}
                  placeholder="API key"
                  aria-label="API key"
                />
                <button type="submit" className="btn" disabled={!connectKey.trim() || connecting || conn !== "open"}>
                  {connecting ? "Connecting…" : "Connect"}
                </button>
              </div>
            </form>
            {customOpen ? (
              <form className="connect" onSubmit={submitCustomConnect}>
                <span className="connect__label">Your own endpoint</span>
                <div className="connect__col">
                  <input
                    className="connect__input"
                    value={customId}
                    onChange={(e) => setCustomId(e.target.value)}
                    placeholder="name, e.g. my-modal"
                    aria-label="provider name"
                    autoComplete="off"
                  />
                  <input
                    className="connect__input"
                    type="url"
                    inputMode="url"
                    value={customBaseUrl}
                    onChange={(e) => setCustomBaseUrl(e.target.value)}
                    placeholder="https://…/v1"
                    aria-label="base URL"
                    autoComplete="off"
                  />
                  <input
                    className="connect__input"
                    value={customModelId}
                    onChange={(e) => setCustomModelId(e.target.value)}
                    placeholder="model id"
                    aria-label="model id"
                    autoComplete="off"
                  />
                  <input
                    className="connect__input"
                    type="password"
                    value={customKey}
                    onChange={(e) => setCustomKey(e.target.value)}
                    placeholder="API key (or $ENV_VAR)"
                    aria-label="custom API key"
                    autoComplete="off"
                  />
                  <div className="connect__row">
                    <button
                      type="submit"
                      className="btn"
                      disabled={
                        !customId.trim() || !customBaseUrl.trim() || !customModelId.trim() ||
                        !customKey.trim() || connecting || conn !== "open"
                      }
                    >
                      {connecting ? "Connecting…" : "Add endpoint"}
                    </button>
                    <button type="button" className="connect__toggle" onClick={() => setCustomOpen(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              </form>
            ) : (
              <button type="button" className="connect__toggle" onClick={() => setCustomOpen(true)}>
                Add your own endpoint
              </button>
            )}
          </div>
        </div>
      )}

      <div className="list" ref={listRef}>
        {empty ? (
          <div className="empty">
            <p className="empty__title">Ask anything</p>
            <p className="empty__sub">Your message will stream a reply here.</p>
          </div>
        ) : (
          state.messages.map((m) => (
            <div key={m.id} className={`msg msg--${m.role}`}>
              {m.role === "assistant" && m.tools && m.tools.length > 0 && (
                <div className="activity" aria-label="tool activity">
                  {m.tools.map((tc) => (
                    <div key={tc.id} className={`activity__row activity__row--${tc.status}`}>
                      <span className="activity__icon" aria-hidden="true">
                        {tc.status === "running" ? <span className="activity__spinner" /> : TOOL_ICON[tc.status]}
                      </span>
                      <span className="activity__name">{tc.name}</span>
                      {tc.args !== undefined && <span className="activity__args">{formatArgs(tc.args)}</span>}
                      {tc.output && <pre className="activity__output">{tc.output}</pre>}
                    </div>
                  ))}
                </div>
              )}
              {!(m.role === "assistant" && m.text === "" && m.tools?.length) && (
                <div
                  className={`bubble bubble--${m.role}${
                    m.role === "user" && isQueued(m.text, steer) ? " bubble--queued" : ""
                  }`}
                  // Greyed while Pi still lists it (#95, §5). Not a control:
                  // there is no `clear_queue` on the RPC surface, so a steered
                  // message cannot be taken back and the greying is the whole
                  // of the affordance.
                  title={m.role === "user" && isQueued(m.text, steer) ? "queued — the model reads this at the next tool boundary" : undefined}
                >
                  {m.role === "assistant" && m.text === "" && state.streaming ? (
                    <span className="typing" aria-label="assistant is replying"><i /><i /><i /></span>
                  ) : (
                    m.text
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Only on a relaying socket: every number in it comes from Pi's own
          stream, so a client that has not declared the seam has nothing to
          show and shows nothing (ADR-014's pre-relay path, unchanged). */}
      {relaying && (
        <div className={`strip${barOpen ? " strip--open" : ""}`}>
          <button
            type="button"
            className="strip__row"
            onClick={() => setBarOpen((v) => !v)}
            aria-expanded={barOpen}
            aria-label="session status"
          >
            {runLabel && (
              <span className="strip__run">
                <span className="strip__glyph" aria-hidden="true">π</span>
                {/* Where the row is tight the readout holds its width and the
                    run description ellipsizes: a number cut in half is wrong
                    where a description cut short is still true. */}
                <span className="strip__what">{runLabel}</span>
              </span>
            )}
            <span className="strip__read">
              {bar.context && (
                <span className={`strip__ctx strip__ctx--${bar.context.tone}`}>
                  {bar.context.text}
                  {bar.context.unverified && (
                    <span className="strip__mark" title="declared by the endpoint, not verified against the server">*</span>
                  )}
                </span>
              )}
              {bar.cost && <span className="strip__cost">{bar.cost}</span>}
            </span>
            <span className="strip__chev" aria-hidden="true">▾</span>
          </button>
          {barOpen && (
            <div className="strip__body">
              {bar.fields.length > 0 ? (
                <div className="strip__fields">
                  {bar.fields.map((f) => (
                    <span key={f.key} className="strip__field">
                      {f.key}<b>{f.value}</b>
                    </span>
                  ))}
                </div>
              ) : (
                <div className="strip__note">No tokens billed to this session yet.</div>
              )}
              {bar.right && <div className="strip__meta">{bar.right}</div>}
            </div>
          )}
        </div>
      )}

      {steer.held.length > 0 && (
        <div className="held" aria-label="held messages">
          {steer.held.map((d) => (
            <div className="held__chip" key={d.id}>
              {/* The chip body edits: it returns the text to the composer, which
                  is also how it is removed. One gesture, both affordances. */}
              <button
                type="button"
                className="held__text"
                onClick={() => editHeld(d.id, d.text)}
                aria-label={`edit held message: ${d.text}`}
              >
                {d.text}
              </button>
              {/* A long press has no keyboard equivalent, so steering would be
                  unreachable by keyboard or switch control without this (#95). */}
              <button
                type="button"
                className="held__act"
                onClick={() => { dispatchSteer({ t: "unhold", id: d.id }); steerNow(d.text); }}
                aria-label={`steer now: ${d.text}`}
                title="Send now — the model reads it at the next tool boundary. This cannot be undone."
              >
                ↑
              </button>
              <button
                type="button"
                className="held__act"
                onClick={() => dispatchSteer({ t: "unhold", id: d.id })}
                aria-label={`discard held message: ${d.text}`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <form className="composer" onSubmit={submit}>
        <textarea
          className="composer__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) submit(e); }}
          placeholder={
            conn === "open"
              ? "Message…"
              : conn === "offline"
                ? "Offline — tap Reconnect"
                : "Reconnecting…"
          }
          rows={1}
          aria-label="message"
        />
        {state.streaming ? (
          <>
            {/* Both, not one: §5's stop is "persistent, always one tap", and
                swapping Send for Stop is what left no way to queue or steer
                while the agent worked (#95). */}
            <button
              type="button"
              className="btn btn--send"
              disabled={!draft.trim() || conn !== "open"}
              aria-label="queue message"
              title="Tap to hold this until the run settles. Press and hold to steer it in now."
              onPointerDown={beginSendPress}
              onPointerUp={() => endSendPress(true)}
              onPointerLeave={() => endSendPress(false)}
              onPointerCancel={() => endSendPress(false)}
            >
              Queue
            </button>
            <button type="button" className="btn btn--stop" onClick={stop} aria-label="stop">Stop</button>
          </>
        ) : (
          <button type="submit" className="btn btn--send" disabled={!draft.trim() || conn !== "open"} aria-label="send">
            Send
          </button>
        )}
      </form>
    </div>
  );
}
