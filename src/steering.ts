/**
 * steering.ts — the held draft queue (#95, product-spec §5).
 *
 * Two queues exist and they are not the same queue, which is the whole design:
 *
 *   - `held` is **ours**. A message tapped into the composer while a run is
 *     live is kept here, in the client, and is therefore still editable and
 *     still removable. It becomes an ordinary prompt once the run settles.
 *   - `queued` is **Pi's**, copied verbatim out of `queue_update`. A steered
 *     message is already inside Pi and nobody can retrieve it — there is no
 *     `clear_queue` on the RPC surface, only in the core, so the terminal can
 *     take one back and we cannot. Greying it is the whole affordance.
 *
 * §5 chose the held draft as the default gesture for exactly that asymmetry:
 * the reversible thing is one tap, the irreversible one is deliberate.
 *
 * A settling run is deliberately NOT a trigger here. `Agent.steer` only
 * enqueues — nothing about it starts a run — so a message steered just as a
 * turn ends stays queued until the NEXT run, and clearing on settle would
 * ungrey a bubble Pi is still holding. §5's rule governs: a readout follows
 * the event that reports it. `queue_update` is that event; nothing else may
 * claim to know.
 *
 * Pi identifies a queued message by its TEXT, not by an id — `queue_update`
 * carries `string[]`, and `agent-session.js` dequeues with
 * `indexOf(messageText)` when the user message starts. So text is the only
 * join available, and two identical steered messages are genuinely
 * indistinguishable, in Pi as much as here.
 */

export interface HeldDraft {
  id: string;
  text: string;
}

export interface SteerState {
  held: HeldDraft[];
  queued: string[];
}

export const initialSteer: SteerState = { held: [], queued: [] };

/**
 * A corrupted or hostile store must not be able to grow without bound or hand
 * the composer a non-string, so the restore path caps and type-checks. Held
 * drafts are a convenience, never a system of record.
 */
export const MAX_HELD = 50;

export type SteerAction =
  | { t: "hold"; id: string; text: string }
  | { t: "unhold"; id: string }
  | { t: "queue_update"; steering: string[] }
  | { t: "reset" };

export function steerReducer(s: SteerState, a: SteerAction): SteerState {
  switch (a.t) {
    case "hold": {
      const text = a.text.trim();
      if (!text || s.held.length >= MAX_HELD) return s;
      return { ...s, held: [...s.held, { id: a.id, text }] };
    }
    case "unhold":
      return { ...s, held: s.held.filter((d) => d.id !== a.id) };
    case "queue_update":
      return { ...s, queued: a.steering.filter((t): t is string => typeof t === "string") };
    case "reset":
      // A new or switched session: Pi's queue belongs to the old one, and a
      // reconnect's fresh `session` frame is also how a queue that went stale
      // behind a dropped socket gets cleared. Held drafts are the user's own
      // words and are deliberately NOT dropped.
      return { ...s, queued: [] };
    default:
      return s;
  }
}

/** The draft that flushes next. §5 keeps the rest editable, so they wait their turn. */
export function nextHeld(s: SteerState): HeldDraft | undefined {
  return s.held[0];
}

/**
 * Is this transcript bubble still sitting in Pi's queue?
 *
 * Text-matched, because that is the only identity Pi offers — see the header.
 * Driven by the event that reports it (§5) rather than by what was last sent,
 * so a pickup ungreys the bubble without anything here tracking a lifecycle.
 */
export function isQueued(text: string, s: SteerState): boolean {
  return s.queued.includes(text);
}

export function serializeHeld(held: HeldDraft[]): string {
  return JSON.stringify(held);
}

/** Never throws. A store that cannot be read is an empty store. */
export function parseHeld(raw: string | null | undefined): HeldDraft[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: HeldDraft[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const { id, text } = item as { id?: unknown; text?: unknown };
    if (typeof id !== "string" || typeof text !== "string") continue;
    const trimmed = text.trim();
    if (!trimmed) continue;
    out.push({ id, text: trimmed });
    if (out.length >= MAX_HELD) break;
  }
  return out;
}
