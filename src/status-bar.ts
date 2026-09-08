/**
 * status-bar.ts — the readout, ported from Pi's own terminal footer (#72).
 *
 * Terminal Pi already ships this component. Parity means reproducing what
 * `dist/modes/interactive/components/footer.js` renders (pinned 0.82.0), not
 * designing a new one, so the arithmetic and the formatting here are a
 * deliberate port rather than an interpretation:
 *
 *   ↑{input} ↓{output} R{cacheRead} W{cacheWrite} CH{hit}% ${cost} {pct}%/{window} (auto)
 *
 * Pi does the arithmetic, not us. `getSessionStats()` runs the IDENTICAL walk
 * the footer runs — the same three entry cases through the same
 * `addUsageToTotals` — so `SessionStats.tokens` and `.cost` already are the
 * footer's cumulative line, and `contextUsage` rides along in the same answer.
 * One request gives the whole readout bar one field.
 *
 * That one field is the cache hit rate, which the footer takes from the LATEST
 * assistant message rather than from any total, so it needs entries.
 * `get_entries` takes a `since` cursor and returns the new `leafId`, so after
 * the first full read each refresh pulls only what arrived since.
 *
 * `entry_appended` is NOT a usage signal, and reading it as one is the trap
 * here. Pi emits it from exactly one place — `ExtensionActions.appendEntry` →
 * `appendCustomEntry` (`agent-session.js:1873`, the only emit site in the whole
 * package) — so it fires for custom entries an EXTENSION writes and never for
 * an assistant message, a tool result, or a compaction. A client that sums it
 * shows a cumulative line frozen at whatever the session started with.
 *
 * So both requests ride the turn-lifecycle events (`agent_end`,
 * `compaction_end`) and never a timer: an interval would be traffic raised
 * purely to refresh a display, which ADR-010 rules out by default. At rest
 * nothing is sent and the Sprite sees nothing.
 *
 * `SessionStats.tokens.total` is NOT the numerator for the context percentage.
 * It is the four other fields added together — cumulative over the whole session
 * including history compaction has since removed — so after a few compactions it
 * exceeds the window outright. It is what was billed, and nothing else.
 * `contextUsage` is the live estimate, and it has three states, not two: absent
 * entirely (optional field), present with `tokens: null` from a compaction
 * until the next response, or present with a number.
 *
 * Pure and reducer-shaped: no React, no socket, no clock.
 */

// --- Pi's shapes, read structurally --------------------------------------
// Only the fields this readout uses are named. Pi owns the rest.

/** `Usage` as it rides on a session entry. `cost` is an object, not a number. */
export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** `tokens` is null from a compaction until the next assistant response. */
export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** The slice of `SessionStats` the bar reads — which is nearly all of it. */
export interface SessionStats {
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  cost?: number;
  contextUsage?: ContextUsage;
}

/** The slice of Pi's `Model` the bar reads. */
export interface StatusModel {
  provider: string;
  id: string;
  contextWindow?: number;
  reasoning?: boolean;
}

/** The slice of `RpcSessionState` the bar reads. */
export interface PiSessionState {
  model?: StatusModel;
  thinkingLevel?: string;
  autoCompactionEnabled?: boolean;
}

// --- state ----------------------------------------------------------------

export interface StatusState {
  /** Pi's own totals, from `get_session_stats`. Never summed here. */
  totals: UsageTotals;
  /** The LATEST assistant message's hit rate, not a session average. */
  cacheHitRate?: number;
  /** `leafId` from the last `get_entries`, so the next read asks only for new ones. */
  cursor?: string;
  context?: ContextUsage;
  model?: StatusModel;
  thinkingLevel?: string;
  autoCompaction: boolean;
  /** Distinct providers in the catalog; the footer names the provider only when >1. */
  providerCount: number;
  /**
   * Whether the context window can be trusted as the server's real one (#49: a
   * custom endpoint declared twice the window it enforced). Nothing sets this
   * false yet — no signal on the wire distinguishes a custom endpoint from a
   * built-in one, and Pi trusts `model.contextWindow` for the same reason. The
   * render state exists because #72 decided the answer is to MARK the figure
   * rather than hide it; reading `n_ctx` back (#49) is what would retire it.
   */
  contextWindowUnverified: boolean;
}

export const initialStatus: StatusState = {
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  autoCompaction: true, // Pi's own default until `get_state` says otherwise
  providerCount: 0,
  contextWindowUnverified: false,
};

export type StatusAction =
  /**
   * A page of entries. `leafId` becomes the next cursor. `incremental` says the
   * page was fetched with a `since`, so an absence of assistant messages means
   * "none arrived", not "the session has none".
   */
  | { t: "entries"; entries: unknown[]; leafId?: string | null; incremental: boolean }
  | { t: "stats"; stats: SessionStats }
  | { t: "pi_state"; state: PiSessionState }
  | { t: "thinking"; level: string }
  | { t: "providers"; count: number }
  /** A new or switched session — everything session-scoped goes. */
  | { t: "reset" };

/** Coerce to a finite number. One NaN in the totals poisons every later frame. */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

interface EntryShape {
  type?: string;
  message?: { role?: string; usage?: PiUsage };
}

/**
 * The footer's cache hit rate: `cacheRead / (input + cacheRead + cacheWrite)`
 * on the LATEST assistant message. Not a session average, and not derivable
 * from the totals — which is the whole reason entries are read at all.
 *
 * `undefined` when the page holds no assistant message; `{ rate: undefined }`
 * when the newest one had no prompt tokens, which clears a stale rate rather
 * than leaving the previous one standing.
 */
function latestHitRate(entries: unknown[]): { rate: number | undefined } | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = (entries[i] ?? {}) as EntryShape;
    if (e.type !== "message" || e.message?.role !== "assistant") continue;
    const u = e.message.usage ?? {};
    const prompt = num(u.input) + num(u.cacheRead) + num(u.cacheWrite);
    return { rate: prompt > 0 ? (num(u.cacheRead) / prompt) * 100 : undefined };
  }
  return undefined;
}

export function statusReducer(s: StatusState, a: StatusAction): StatusState {
  switch (a.t) {
    case "entries": {
      const found = latestHitRate(a.entries);
      // A cursored page with no assistant message means none arrived — the
      // standing rate is still the latest one. A full read with none means the
      // session genuinely has none.
      const cacheHitRate = found ? found.rate : a.incremental ? s.cacheHitRate : undefined;
      return { ...s, cacheHitRate, cursor: a.leafId ?? s.cursor };
    }
    case "stats": {
      // Pi ran the footer's own walk; taking its answer is what keeps the two
      // from drifting. `contextUsage` is optional, and absent means Pi has no
      // estimate — not an estimate of zero — so the field goes back to absent.
      const t = a.stats.tokens ?? {};
      return {
        ...s,
        totals: {
          input: num(t.input), output: num(t.output),
          cacheRead: num(t.cacheRead), cacheWrite: num(t.cacheWrite),
          cost: num(a.stats.cost),
        },
        context: a.stats.contextUsage,
      };
    }
    case "pi_state":
      return {
        ...s,
        model: a.state.model ?? s.model,
        thinkingLevel: a.state.thinkingLevel ?? s.thinkingLevel,
        autoCompaction: a.state.autoCompactionEnabled ?? s.autoCompaction,
      };
    case "thinking":
      return { ...s, thinkingLevel: a.level };
    case "providers":
      return { ...s, providerCount: a.count };
    case "reset":
      // The model and the provider count outlive a session; the usage does not.
      // The cursor is a session's entry id — carrying it across would ask the
      // new session for a `since` it has never heard of, which Pi answers with
      // an error rather than an empty page.
      return { ...initialStatus, model: s.model, thinkingLevel: s.thinkingLevel,
               autoCompaction: s.autoCompaction, providerCount: s.providerCount };
    default:
      return s;
  }
}

// --- rendering ------------------------------------------------------------

/** Ported verbatim from the footer's `formatTokens`. */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export type Tone = "normal" | "warn" | "error";

/**
 * Pi's thresholds, not ours: `> 90%` is the error colour and `> 70%` the
 * warning one. A UI that invents its own diverges from the terminal for no
 * reason. An unknown percentage reads as `0` here exactly as it does in the
 * footer (`contextUsage?.percent ?? 0`), so `?` is never alarming.
 */
export function contextTone(percent: number | null | undefined): Tone {
  const v = percent ?? 0;
  if (v > 90) return "error";
  if (v > 70) return "warn";
  return "normal";
}

export interface ReadoutField {
  key: string;
  value: string;
}

export interface ContextReadout {
  text: string;
  tone: Tone;
  /** The window is the endpoint's declared figure, unchecked against its server. */
  unverified: boolean;
}

export interface Readout {
  /** The cumulative line: ↑ ↓ R W CH. Only fields that have a number. */
  fields: ReadoutField[];
  cost?: string;
  /** Absent only when the window itself is unknown. */
  context?: ContextReadout;
  /** `(provider) model • thinking` — the footer's right-hand side. */
  right?: string;
}

/**
 * Kimi Coding is subscription-backed despite authenticating with an API key, so
 * the footer marks its cost `(sub)`. The footer also marks any OAuth-backed
 * provider that way, via `modelRuntime.isUsingOAuth` — which has no RPC
 * equivalent, so that half cannot be reproduced from a client and those
 * providers show an unmarked cost until something on the wire says otherwise.
 */
const SUBSCRIPTION_PROVIDERS: ReadonlySet<string> = new Set(["kimi-coding"]);

export function readout(s: StatusState): Readout {
  const t = s.totals;
  const fields: ReadoutField[] = [];
  // Omit rather than blank. Pi writes a field only when it has one, so a model
  // with no prompt cache gets a SHORTER bar instead of a row of dashes.
  if (t.input) fields.push({ key: "↑", value: formatTokens(t.input) });
  if (t.output) fields.push({ key: "↓", value: formatTokens(t.output) });
  if (t.cacheRead) fields.push({ key: "R", value: formatTokens(t.cacheRead) });
  if (t.cacheWrite) fields.push({ key: "W", value: formatTokens(t.cacheWrite) });
  if ((t.cacheRead > 0 || t.cacheWrite > 0) && s.cacheHitRate !== undefined) {
    fields.push({ key: "CH", value: `${s.cacheHitRate.toFixed(1)}%` });
  }

  const sub = s.model ? SUBSCRIPTION_PROVIDERS.has(s.model.provider) : false;
  const cost = t.cost || sub ? `$${t.cost.toFixed(3)}${sub ? " (sub)" : ""}` : undefined;

  // The footer falls back to the model's own window when the estimate carries
  // none, and would render `?/0` when neither has one. A denominator of zero
  // says nothing, so the field drops out instead — #72's "omit rather than
  // blank" applied to the one field the footer always pushes.
  const window = s.context?.contextWindow ?? s.model?.contextWindow ?? 0;
  let context: ContextReadout | undefined;
  if (window > 0) {
    // Three states, two of them non-numeric. The footer's own test is
    // `contextUsage?.percent !== null`, which renders an ABSENT `contextUsage`
    // as `0.0%` rather than `?` — a figure that reads as an empty context when
    // the truth is that Pi has no estimate. Both unknowns read as `?` here.
    const percent = s.context?.percent;
    const head = percent === null || percent === undefined ? "?" : `${percent.toFixed(1)}%`;
    const auto = s.autoCompaction ? " (auto)" : "";
    context = {
      text: `${head}/${formatTokens(window)}${auto}`,
      tone: contextTone(percent),
      unverified: s.contextWindowUnverified,
    };
  }

  let right: string | undefined;
  if (s.model) {
    right = s.model.id;
    if (s.model.reasoning) {
      const level = s.thinkingLevel || "off";
      right = level === "off" ? `${right} • thinking off` : `${right} • ${level}`;
    }
    // The provider is named only when there is more than one to tell apart.
    if (s.providerCount > 1) right = `(${s.model.provider}) ${right}`;
  }

  return { fields, cost, context, right };
}

// --- routing --------------------------------------------------------------

/**
 * Every Pi command the bar sends carries an id under this prefix. A relaying
 * socket is forwarded EVERY response, including the ones the bridge asked for
 * itself, so the prefix is what separates an answer to our question from an
 * answer to someone else's.
 */
export const STATUS_ID = "grtbx-status:";

/**
 * A Pi read the bar issues. `get_entries` carries the cursor when it has one;
 * both are on the relay list and neither writes anything.
 */
export type StatusAsk =
  | { type: "get_session_stats" }
  | { type: "get_entries"; since?: string };

export interface StatusRouting {
  actions: StatusAction[];
  ask: StatusAsk[];
}

const NOTHING: StatusRouting = { actions: [], ask: [] };

/** Everything, from the top: the session changed or we have no cursor yet. */
const FULL: StatusAsk[] = [{ type: "get_session_stats" }, { type: "get_entries" }];

/** A turn ended: Pi's totals again, plus whatever entries are new since. */
const since = (cursor?: string): StatusAsk[] =>
  [{ type: "get_session_stats" }, { type: "get_entries", ...(cursor ? { since: cursor } : {}) }];

export interface RouteContext {
  /**
   * Whether the `hello` behind this frame named a session, read before that id
   * is overwritten. When it did, a resume may still be in flight.
   */
  couldResume: boolean;
  /** The last `leafId` seen, if any. */
  cursor?: string;
}

/**
 * Everything the bar needs, and only what it needs, out of one inbound frame.
 *
 * The subtlety this exists to pin down is WHEN a request may be sent. Pi does
 * not serialize `switch_session` against the commands behind it — the handler
 * loop starts each line without awaiting the last — and the bridge refuses
 * relayed commands while that switch is pending, with an error the user sees in
 * the transcript. So a refresh goes out at exactly two moments: the
 * `switch_session` response, which is the restore ending, and a `session` frame
 * for a `hello` that carried no session id, where no resume was possible. A
 * resumed session with no Pi file on disk gets neither and needs neither: it
 * has no entries, and its window arrives with the bridge's own `get_state`.
 */
export function routeStatusFrame(
  f: { type?: string; [k: string]: unknown },
  ctx: RouteContext,
): StatusRouting {
  switch (f.type) {
    case "session":
      // Session-scoped: the readout starts over wherever we just landed.
      return { actions: [{ t: "reset" }], ask: ctx.couldResume ? [] : FULL };
    case "thinking_level_changed":
      return { actions: [{ t: "thinking", level: String(f.level ?? "off") }], ask: [] };
    // A compaction rewrites the estimate outright. `agent_end` is the end of a
    // loop rather than of the turn (#77), which makes it the earliest honest
    // moment to re-read — and re-reading twice in a turn costs two cursored
    // requests, which is what riding real events instead of a timer buys.
    case "compaction_end":
    case "agent_end":
      return { actions: [], ask: since(ctx.cursor) };
    case "response":
      break;
    default:
      // `entry_appended` lands here on purpose. Pi emits it only for custom
      // entries an extension wrote (`agent-session.js:1873` is the sole emit
      // site), so it carries no usage and is not a turn signal.
      return NOTHING;
  }

  // Facts about the session belong to the session, not to whoever asked: the
  // bridge issues `get_state` on every session start and reads every
  // `set_model` response regardless of sender, on exactly this reasoning.
  if (f.command === "switch_session") return { actions: [], ask: FULL };
  if (f.command === "get_state" && f.success === true) {
    return { actions: [{ t: "pi_state", state: f.data as PiSessionState }], ask: [] };
  }
  if (f.command === "set_model" && f.success === true) {
    return { actions: [{ t: "pi_state", state: { model: f.data as StatusModel } }], ask: [] };
  }
  if (typeof f.id !== "string" || !f.id.startsWith(STATUS_ID)) return NOTHING;
  if (f.command === "get_entries" && f.success !== true) {
    // "Entry not found" — a cursor outlives the branch it pointed into whenever
    // a fork or a compaction rewrites history. Pi answers that with an error
    // rather than an empty page, so drop the cursor and read the branch whole.
    return { actions: [], ask: [{ type: "get_entries" }] };
  }
  if (f.success !== true) return NOTHING;
  if (f.command === "get_session_stats") return { actions: [{ t: "stats", stats: f.data as SessionStats }], ask: [] };
  if (f.command === "get_entries") {
    const d = (f.data ?? {}) as { entries?: unknown[]; leafId?: string | null };
    return {
      actions: [{ t: "entries", entries: d.entries ?? [], leafId: d.leafId, incremental: ctx.cursor !== undefined }],
      ask: [],
    };
  }
  return NOTHING;
}
