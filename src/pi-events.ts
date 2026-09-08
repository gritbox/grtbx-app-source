/**
 * pi-events.ts — Pi's own event stream, translated into the reducer's actions.
 *
 * ADR-015 makes the bridge a relay: a client that declares `hello.seam` gets
 * every event Pi emits, unchanged, and stops getting the bridge's translated
 * `token`/`tool_*`/`done` frames (`pi-session.ts` — `sendTranslated` is a no-op
 * once relaying). So the modelling the bridge used to do moves here, which is
 * the point of the ADR: the bridge filters, the client models.
 *
 * This is a port of the bridge's own translation, kept deliberately faithful so
 * the two do not drift while both paths exist. The three findings baked into it
 * are worth not re-deriving:
 *
 *   - `agent_end` is NOT the end of a turn (#77). Pi emits it at the end of an
 *     agent *loop* and may then auto-retry, compact, or run a queued
 *     continuation and keep writing. It only carries the run's final messages,
 *     so it is held rather than acted on.
 *   - `agent_settled` is the real end. Pi emits it once per prompt run from a
 *     `finally`, so it arrives even when the run threw or was aborted.
 *   - A failed run settles with `stopReason: "error"` and an `errorMessage` on
 *     the final assistant message (#17). Reporting that as a clean `done`
 *     renders as a silent empty bubble, so it becomes an error action instead.
 *     "aborted" (the user's own stop) is a normal end and stays `done`.
 */

import type { Action } from "./reducer";

/** Pi's events are Pi's business; we read the few fields we translate. */
export interface PiEvent {
  type: string;
  [k: string]: unknown;
}

/** True for a frame off the relay rather than a bridge `BridgeMsg`. */
export function isPiEvent(m: { type?: unknown }): boolean {
  return typeof m?.type === "string" && PI_EVENT_TYPES.has(m.type);
}

/** The event types this translator acts on. Anything else crosses and is ignored. */
const PI_EVENT_TYPES = new Set([
  "message_update",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "auto_retry_start",
  "agent_end",
  "agent_settled",
]);

/**
 * A tool result may be a string, a `{ content: [{ text }] }` block list, or a
 * `{ text }` object. Ported from the bridge's `displayValue`.
 */
export function displayValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as { content?: unknown; text?: unknown };
    if (Array.isArray(o.content)) {
      const text = o.content
        .map((b) =>
          b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
            ? (b as { text: string }).text
            : "",
        )
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
    if (typeof o.text === "string") return o.text;
  }
  try { return JSON.stringify(v); } catch { return String(v); }
}

function lastAssistant(messages: unknown): { stopReason?: string; errorMessage?: unknown } | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; stopReason?: string; errorMessage?: unknown };
    if (m?.role === "assistant") return m;
  }
  return undefined;
}

export interface PiTranslator {
  /** Actions for one Pi event, in order. Empty when the event needs no UI change. */
  handle(e: PiEvent): Action[];
}

/**
 * Stateful only where Pi's protocol forces it: `agent_end` carries the run's
 * final messages and `agent_settled` decides what they meant, so the messages
 * are held between the two.
 */
export function createPiTranslator(): PiTranslator {
  let endMessages: unknown;

  return {
    handle(e: PiEvent): Action[] {
      switch (e.type) {
        case "message_update": {
          const ev = e.assistantMessageEvent as { type?: string; delta?: unknown; error?: unknown } | undefined;
          if (ev?.type === "text_delta") return [{ t: "token", delta: String(ev.delta ?? "") }];
          if (ev?.type === "error") return [{ t: "error", message: String(ev.error ?? "inference error") }];
          return [];
        }
        case "tool_execution_start":
          return [{
            t: "tool_start",
            toolCallId: String(e.toolCallId),
            name: String(e.toolName ?? ""),
            args: e.args,
          }];
        case "tool_execution_update":
          return [{
            t: "tool_update",
            toolCallId: String(e.toolCallId),
            output: displayValue(e.partialResult),
          }];
        case "tool_execution_end":
          return [{
            t: "tool_end",
            toolCallId: String(e.toolCallId),
            ok: !e.isError,
            output: displayValue(e.result),
          }];
        case "auto_retry_start":
          // Pi drops the failed attempt's assistant message from its own state
          // before retrying (`_prepareRetry`), so what it streamed is not part
          // of the conversation. Drop it here too, or the retried reply arrives
          // glued to the tail of the attempt it replaced.
          return [{ t: "retry_reset" }];
        case "agent_end":
          endMessages = e.messages;
          return [];
        case "agent_settled": {
          const last = lastAssistant(endMessages);
          endMessages = undefined;
          if (last?.stopReason === "error") {
            return [{ t: "error", message: String(last.errorMessage ?? "inference failed") }];
          }
          return [{ t: "done" }];
        }
        default:
          return [];
      }
    },
  };
}
