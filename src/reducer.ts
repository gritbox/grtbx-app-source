/**
 * reducer.ts — the pure chat state machine, decoupled from React and the socket
 * so it is unit-testable. Mirrors the protocol.ts contract (spec 002 + issue #2
 * + issue #4): send → user bubble + empty assistant bubble (streaming); token →
 * append delta; tool_start/tool_update/tool_end → live rows on the in-flight
 * assistant turn; done → finalize (any still-running tool row is marked
 * stopped, never left spinning); error → surface as a message, never a crash;
 * load_session → replace the whole message list with a resumed/new session's
 * transcript; disconnected (issue #5) → a socket drop mid-turn stops the
 * local spinner/running tool rows without appending a visible error — the
 * reconnect's replayed transcript is the truth, so nothing here is presented
 * as a final answer, and nothing is duplicated when it arrives.
 */

export type Role = "user" | "assistant" | "error";
export type ToolStatus = "running" | "ok" | "error" | "stopped";
export interface ToolCall {
  id: string;
  name: string;
  args?: unknown;
  output: string;
  status: ToolStatus;
}
export interface Msg {
  id: number;
  role: Role;
  text: string;
  tools?: ToolCall[];
}

export interface ChatState {
  messages: Msg[];
  streaming: boolean;
  nextId: number;
}

export type Action =
  | { t: "send"; text: string }
  | { t: "token"; delta: string }
  | { t: "tool_start"; toolCallId: string; name: string; args?: unknown }
  | { t: "tool_update"; toolCallId: string; output: string }
  | { t: "tool_end"; toolCallId: string; ok: boolean; output?: string }
  | { t: "done" }
  | { t: "error"; message: string }
  | { t: "load_session"; turns: { role: "user" | "assistant"; text: string }[] }
  | { t: "disconnected" };

/** Find the last assistant message and replace it with `fn`'s result. No-op if none. */
function updateLastAssistant(msgs: Msg[], fn: (m: Msg) => Msg): Msg[] {
  const out = msgs.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "assistant") { out[i] = fn(out[i]); break; }
  }
  return out;
}

/** Any tool row still "running" (e.g. the turn was stopped mid-call) stops spinning. */
function stopRunningTools(m: Msg): Msg {
  if (!m.tools?.some((tc) => tc.status === "running")) return m;
  return { ...m, tools: m.tools.map((tc) => (tc.status === "running" ? { ...tc, status: "stopped" } : tc)) };
}

export const initialState: ChatState = { messages: [], streaming: false, nextId: 1 };

export function reducer(s: ChatState, a: Action): ChatState {
  switch (a.t) {
    case "send": {
      const user: Msg = { id: s.nextId, role: "user", text: a.text };
      const assistant: Msg = { id: s.nextId + 1, role: "assistant", text: "" };
      return { messages: [...s.messages, user, assistant], streaming: true, nextId: s.nextId + 2 };
    }
    case "token": {
      if (!s.streaming) return s;
      const msgs = s.messages.slice();
      // append to the last assistant bubble
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant") {
          msgs[i] = { ...msgs[i], text: msgs[i].text + a.delta };
          break;
        }
      }
      return { ...s, messages: msgs };
    }
    case "tool_start": {
      if (!s.streaming) return s;
      const tools = updateLastAssistant(s.messages, (m) => ({
        ...m,
        tools: [...(m.tools ?? []), { id: a.toolCallId, name: a.name, args: a.args, output: "", status: "running" as const }],
      }));
      return { ...s, messages: tools };
    }
    case "tool_update": {
      if (!s.streaming) return s;
      const msgs = updateLastAssistant(s.messages, (m) => ({
        ...m,
        tools: (m.tools ?? []).map((tc) => (tc.id === a.toolCallId ? { ...tc, output: a.output } : tc)),
      }));
      return { ...s, messages: msgs };
    }
    case "tool_end": {
      if (!s.streaming) return s;
      const msgs = updateLastAssistant(s.messages, (m) => ({
        ...m,
        tools: (m.tools ?? []).map((tc) =>
          tc.id === a.toolCallId
            ? { ...tc, status: (a.ok ? "ok" : "error") as ToolStatus, output: a.output ?? tc.output }
            : tc,
        ),
      }));
      return { ...s, messages: msgs };
    }
    case "done":
      return { ...s, streaming: false, messages: updateLastAssistant(s.messages, stopRunningTools) };
    case "error": {
      // Surface the failure as a message; stop streaming. Leave any partial
      // assistant text in place (a stop/failure keeps what already arrived).
      const err: Msg = { id: s.nextId, role: "error", text: a.message };
      const messages = updateLastAssistant(s.messages, stopRunningTools);
      return { messages: [...messages, err], streaming: false, nextId: s.nextId + 1 };
    }
    case "disconnected": {
      if (!s.streaming) return s; // nothing in flight — a no-op, safe to fire on every state change
      return { ...s, streaming: false, messages: updateLastAssistant(s.messages, stopRunningTools) };
    }
    case "load_session": {
      let id = 1;
      const messages: Msg[] = a.turns.map((t) => ({ id: id++, role: t.role, text: t.text }));
      return { messages, streaming: false, nextId: id };
    }
    default:
      return s;
  }
}
