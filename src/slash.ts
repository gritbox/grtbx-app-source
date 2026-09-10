/**
 * slash.ts — the slash overlay's grammar (issue #7, decided in grtbx#69).
 *
 * Typing `/` in the composer raises a list carrying two families that look
 * alike and are not:
 *
 *   - **Pi's own commands**, from `get_commands`. Each is a prompt Pi resolves
 *     itself, so picking one only writes text into the composer. The overlay
 *     never needs to know what any of them mean.
 *   - **grtbx's control verbs**, which Pi never reports because they are
 *     session state rather than prompts. Picking one sends its RPC command.
 *
 * They are shown as two labelled groups because picking one sends a prompt and
 * picking the other changes the session, and that difference is not cosmetic.
 *
 * A control verb applies IMMEDIATELY, the way it does in the terminal. The
 * prototype (`lab/experiments/prototypes/slash-overlay/` in grtbx) carries a
 * toggle between that and holding a modifier on the composer; the toggle exists
 * to make the fork visible, and the decision was immediate. Nothing is held, so
 * nothing can be half-applied.
 *
 * This module is pure: it decides what the overlay lists and what a choice
 * means. Sending and rendering belong to App.tsx.
 */

import type { ModelSummary } from "./ws";

/**
 * One of Pi's registered commands, exactly as `get_commands` reports it
 * (`RpcSlashCommand`). Skills arrive already namespaced `skill:<name>`.
 *
 * There is no argument list, no schema and no placeholders — these four fields
 * are the whole shape. So the overlay never builds a form for one of Pi's
 * commands: there is nothing to build it from. An extension that needs input
 * asks through `extension_ui_request`, which is grtbx#44 and not this module.
 */
export interface PiSlashCommand {
  name: string;
  description?: string;
  source?: string;
  sourceInfo?: string;
}

/** How a control verb gets its argument, when it takes one. */
export type VerbArgs =
  | { kind: "none" }
  /** A menu Pi itself answers — the values come off the wire, never a literal here. */
  | { kind: "menu"; ask: "thinking" }
  /** Hand off to a sheet that already exists rather than rebuild its picker. */
  | { kind: "sheet"; sheet: "model" }
  /** Free text, taken in a second pane. */
  | { kind: "text"; placeholder: string };

/** A grtbx control verb: a name in the overlay, an RPC command underneath. */
export interface ControlVerb {
  name: string;
  description: string;
  /** The Pi RPC command this sends. Every one is on the bridge's relay list. */
  rpc: string;
  args: VerbArgs;
}

/**
 * The control verbs, checked against `app/bridge/src/relay.ts` at grtbx
 * `caaada9`. Two from the prototype are deliberately absent:
 *
 *   - **`/export`** — the relay REFUSES `export_html`, because it writes a file
 *     and returns a Sprite-local path, and delivering that file is the bridge's
 *     problem (grtbx#74). Listing it would offer a command that cannot land.
 *   - **`/fork`** — `fork` is relayed, but it takes an `entryId` and there is
 *     no way to pick a message yet (grtbx#71), nor a decision about what a fork
 *     means on a phone (grtbx#74). A `/fork` with nothing to fork from is not a
 *     feature.
 */
export const CONTROL_VERBS: readonly ControlVerb[] = [
  {
    name: "thinking",
    description: "Set the reasoning level",
    rpc: "set_thinking_level",
    args: { kind: "menu", ask: "thinking" },
  },
  {
    name: "model",
    description: "Switch the model",
    rpc: "set_model",
    args: { kind: "sheet", sheet: "model" },
  },
  {
    name: "compact",
    description: "Compact the conversation now",
    rpc: "compact",
    args: { kind: "none" },
  },
  {
    name: "name",
    description: "Name this conversation",
    rpc: "set_session_name",
    args: { kind: "text", placeholder: "Name this conversation" },
  },
];

/**
 * Whether the composer's text should raise the overlay, and on what query.
 *
 * The rule is deliberately narrow: `/` must be the FIRST character, so a slash
 * inside a sentence or a file path never raises the list. A space ends it — by
 * then the text is a prompt being written, not a command being chosen.
 */
export function slashQuery(draft: string): string | null {
  if (!draft.startsWith("/")) return null;
  const rest = draft.slice(1);
  if (/\s/.test(rest)) return null;
  return rest;
}

export interface SlashGroups {
  verbs: ControlVerb[];
  commands: PiSlashCommand[];
}

/**
 * Filter both families by the same rule: a case-insensitive SUBSTRING match,
 * not a prefix. `/com` reaches `compact` and `commit` alike, which is why the
 * keyboard stays up when the overlay opens — typing is how the list narrows.
 *
 * Pi's names keep their own order (Pi returns extensions, then prompt
 * templates, then skills) rather than being re-sorted here.
 */
export function filterSlash(
  query: string,
  commands: readonly PiSlashCommand[],
  verbs: readonly ControlVerb[] = CONTROL_VERBS,
): SlashGroups {
  const q = query.toLowerCase();
  return {
    verbs: verbs.filter((v) => v.name.toLowerCase().includes(q)),
    commands: commands.filter((c) => c.name.toLowerCase().includes(q)),
  };
}

/** True when neither family has a match, so the overlay says so rather than showing nothing. */
export function isEmpty(g: SlashGroups): boolean {
  return g.verbs.length === 0 && g.commands.length === 0;
}

/**
 * Whether a model can think, by Pi's own test: `supportsThinking()` is
 * `!!model.reasoning`. The bridge already sends `reasoning` on every
 * `ModelSummary` (grtbx#79); a row Pi could not describe leaves it undefined,
 * which reads as "cannot", the same way Pi reads it.
 */
export function supportsThinking(m: Pick<ModelSummary, "reasoning">): boolean {
  return !!m.reasoning;
}

/**
 * Whether switching to `next` would drop the thinking level, so the picker can
 * say it BEFORE the switch instead of surprising the user after it.
 *
 * This exists because of an asymmetry in what Pi reports. Switching model
 * re-clamps the thinking level to whatever the new model supports, and:
 *
 *   - the model change itself goes to extensions only, never to the RPC stream;
 *   - the clamp it caused DOES arrive, as `thinking_level_changed`.
 *
 * So the readout repaints from the clamp while the cause is invisible. The rule
 * the spec draws from that is `§5`: every control readout is driven by the
 * event that reports it, never by what the user last picked. This function is
 * the one place a prediction is allowed, and it only warns — it never writes
 * the level, because the level is the event's to report.
 */
export function wouldDropThinking(
  next: Pick<ModelSummary, "reasoning">,
  thinkingLevel: string | undefined,
): boolean {
  if (thinkingLevel === undefined || thinkingLevel === "off") return false;
  return !supportsThinking(next);
}

// --- Pi's answers ----------------------------------------------------------

/**
 * Tags the overlay's own reads so their answers come back here and not to the
 * status bar's router, which owns a different set of commands under its own
 * prefix (`status-bar.ts`).
 */
export const SLASH_ID = "grtbx-slash:";

/** One of Pi's read commands the overlay issues. */
export type SlashAsk =
  | { type: "get_commands" }
  | { type: "get_available_thinking_levels" };

/** Read both when the overlay first opens; neither is on a timer. */
export const SLASH_READS: readonly SlashAsk[] = [
  { type: "get_commands" },
  { type: "get_available_thinking_levels" },
];

export type SlashAction =
  | { t: "commands"; commands: PiSlashCommand[] }
  | { t: "thinking_levels"; levels: string[] }
  /** A read failed. The overlay keeps working on the family that did answer. */
  | { t: "read_failed"; command: string };

/**
 * Route one frame for the overlay. Returns the actions it means, or none.
 *
 * Only frames carrying our own `id` prefix are read, so another sender's
 * `get_commands` — an extension's, say — never redraws this list.
 */
export function routeSlashFrame(f: { type?: string; [k: string]: unknown }): SlashAction[] {
  if (f.type !== "response") return [];
  if (typeof f.id !== "string" || !f.id.startsWith(SLASH_ID)) return [];
  const command = typeof f.command === "string" ? f.command : "";
  if (command !== "get_commands" && command !== "get_available_thinking_levels") return [];
  if (f.success !== true) return [{ t: "read_failed", command }];

  if (command === "get_commands") {
    return [{ t: "commands", commands: readCommands(f.data) }];
  }
  return [{ t: "thinking_levels", levels: readLevels(f.data) }];
}

/**
 * Pi's shape is Pi's business, so this reads defensively rather than asserting.
 * `get_commands` has answered as a bare array and as `{ commands: [...] }`
 * across versions; accept either and drop anything without a usable name.
 */
export function readCommands(data: unknown): PiSlashCommand[] {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as { commands?: unknown })?.commands)
      ? ((data as { commands: unknown[] }).commands)
      : [];
  const out: PiSlashCommand[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.name !== "string" || o.name.length === 0) continue;
    out.push({
      name: o.name,
      description: typeof o.description === "string" ? o.description : undefined,
      source: typeof o.source === "string" ? o.source : undefined,
      sourceInfo: typeof o.sourceInfo === "string" ? o.sourceInfo : undefined,
    });
  }
  return out;
}

/** The same defensiveness for the thinking menu: a bare array or `{ levels }`. */
export function readLevels(data: unknown): string[] {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as { levels?: unknown })?.levels)
      ? ((data as { levels: unknown[] }).levels)
      : [];
  return rows.filter((l): l is string => typeof l === "string" && l.length > 0);
}

// --- what a choice means ---------------------------------------------------

/**
 * What picking something does. `prompt` writes text into the composer and sends
 * nothing; `send` is one of Pi's commands, applied at once; `pane` opens the
 * second pane; `sheet` hands off to a sheet that already exists.
 */
export type SlashChoice =
  | { kind: "prompt"; text: string }
  | { kind: "send"; command: { type: string; [k: string]: unknown } }
  | { kind: "pane"; verb: ControlVerb }
  | { kind: "sheet"; sheet: "model" };

/**
 * Picking one of Pi's commands is not a special mechanism. It writes
 * `/<name> ` into the composer and the user sends it like any message — Pi
 * resolves the prompt at its end. Nothing changes in the session.
 *
 * The trailing space is deliberate: most of these take free text after the
 * name, and Pi tells us nothing about which, so the composer is left ready to
 * type rather than guessing.
 */
export function choosePiCommand(c: PiSlashCommand): Extract<SlashChoice, { kind: "prompt" }> {
  return { kind: "prompt", text: `/${c.name} ` };
}

/**
 * Picking a control verb: straight to Pi, or into the second pane first.
 *
 * Never `prompt` — that is the other family's outcome, and saying so in the
 * type is what lets a caller handle the three cases without a fallback branch
 * it can never reach.
 */
export function chooseVerb(v: ControlVerb): Exclude<SlashChoice, { kind: "prompt" }> {
  switch (v.args.kind) {
    case "none":
      return { kind: "send", command: { type: v.rpc } };
    case "sheet":
      return { kind: "sheet", sheet: v.args.sheet };
    default:
      return { kind: "pane", verb: v };
  }
}

/**
 * The command a verb's argument produces. Pi validates its own arguments and
 * always answers, so the shapes here are Pi's field names and nothing more.
 */
export function verbCommand(v: ControlVerb, arg: string): { type: string; [k: string]: unknown } {
  switch (v.rpc) {
    case "set_thinking_level":
      return { type: v.rpc, level: arg };
    case "set_session_name":
      return { type: v.rpc, name: arg };
    default:
      return { type: v.rpc };
  }
}
