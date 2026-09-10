import assert from "node:assert/strict";
import {
  slashQuery, filterSlash, isEmpty, CONTROL_VERBS,
  supportsThinking, wouldDropThinking,
  routeSlashFrame, readCommands, readLevels, SLASH_ID,
  choosePiCommand, chooseVerb, verbCommand,
  type PiSlashCommand, type ControlVerb,
} from "../src/slash.ts";

let n = 0;
const ok = (name: string, f: () => void) => { f(); n++; void name; };

const PI: PiSlashCommand[] = [
  { name: "review", description: "Review the working tree", source: "extension" },
  { name: "commit", description: "Stage and commit", source: "extension" },
  { name: "explain", description: "Explain the code", source: "prompt" },
  { name: "skill:changelog", description: "Draft a changelog", source: "skill" },
];

const verb = (name: string): ControlVerb => {
  const v = CONTROL_VERBS.find((c) => c.name === name);
  assert.ok(v, `no such verb: ${name}`);
  return v;
};

// ------------------------------------------------------------- raising the list

ok("a leading slash raises the overlay, and the query is what follows it", () => {
  assert.equal(slashQuery("/"), "");
  assert.equal(slashQuery("/com"), "com");
});

ok("a slash that is not first never raises it", () => {
  assert.equal(slashQuery("see src/App.tsx"), null);
  assert.equal(slashQuery(" /compact"), null);
  assert.equal(slashQuery(""), null);
});

ok("a space ends the command and returns to writing a prompt", () => {
  // By then `/review ` is a message being written, not a command being chosen.
  assert.equal(slashQuery("/review "), null);
  assert.equal(slashQuery("/review the diff"), null);
  assert.equal(slashQuery("/name\tx"), null);
});

// ------------------------------------------------------------------ filtering

ok("the filter is a substring, not a prefix, and one rule serves both families", () => {
  const g = filterSlash("com", PI);
  // "com" must reach the verb `compact` AND Pi's `commit` — the point of the rule.
  assert.deepEqual(g.verbs.map((v) => v.name), ["compact"]);
  assert.deepEqual(g.commands.map((c) => c.name), ["commit"]);
});

ok("the filter ignores case in both families", () => {
  assert.deepEqual(filterSlash("REVIEW", PI).commands.map((c) => c.name), ["review"]);
  assert.deepEqual(filterSlash("MODEL", PI).verbs.map((v) => v.name), ["model"]);
});

ok("an empty query shows everything", () => {
  const g = filterSlash("", PI);
  assert.equal(g.verbs.length, CONTROL_VERBS.length);
  assert.equal(g.commands.length, PI.length);
  assert.equal(isEmpty(g), false);
});

ok("a namespaced skill is matched by its bare name too", () => {
  assert.deepEqual(filterSlash("changelog", PI).commands.map((c) => c.name), ["skill:changelog"]);
  assert.deepEqual(filterSlash("skill:", PI).commands.map((c) => c.name), ["skill:changelog"]);
});

ok("no match in either family is reported, not shown as an empty panel", () => {
  const g = filterSlash("zzz", PI);
  assert.deepEqual(g.verbs, []);
  assert.deepEqual(g.commands, []);
  assert.equal(isEmpty(g), true);
});

ok("Pi's own order is kept rather than re-sorted here", () => {
  assert.deepEqual(filterSlash("", PI).commands.map((c) => c.name), PI.map((c) => c.name));
});

// -------------------------------------------------------------- the verb list

ok("no verb is offered that the bridge's relay refuses", () => {
  // `export_html` is REFUSED by relay.ts — it returns a Sprite-local path and
  // delivering the file is the bridge's problem (grtbx#74). Offering it would
  // put a command in the list that cannot land.
  assert.equal(CONTROL_VERBS.some((v) => v.rpc === "export_html"), false);
  assert.equal(CONTROL_VERBS.some((v) => v.name === "export"), false);
});

ok("no verb is offered that has nothing to act on yet", () => {
  // `fork` is relayed but takes an entryId, and there is no way to pick a
  // message (grtbx#71) nor a decision on what a fork means here (grtbx#74).
  assert.equal(CONTROL_VERBS.some((v) => v.rpc === "fork"), false);
});

ok("every verb names a command the relay carries", () => {
  const relayed = new Set(["set_thinking_level", "set_model", "compact", "set_session_name"]);
  for (const v of CONTROL_VERBS) assert.ok(relayed.has(v.rpc), `${v.name} -> ${v.rpc}`);
});

// -------------------------------------------------------------- what a choice does

ok("picking one of Pi's commands only writes to the composer", () => {
  const c = choosePiCommand(PI[0]);
  assert.deepEqual(c, { kind: "prompt", text: "/review " });
});

ok("a verb with no argument goes straight to Pi", () => {
  assert.deepEqual(chooseVerb(verb("compact")), { kind: "send", command: { type: "compact" } });
});

ok("a verb with a menu opens the second pane instead of sending", () => {
  const c = chooseVerb(verb("thinking"));
  assert.equal(c.kind, "pane");
});

ok("the model verb reuses the sheet that already exists", () => {
  assert.deepEqual(chooseVerb(verb("model")), { kind: "sheet", sheet: "model" });
});

ok("an argument becomes Pi's own field name", () => {
  assert.deepEqual(verbCommand(verb("thinking"), "high"), { type: "set_thinking_level", level: "high" });
  assert.deepEqual(verbCommand(verb("name"), "Deploy work"), { type: "set_session_name", name: "Deploy work" });
});

// --------------------------------------------------- the model / thinking clamp

ok("thinking support is Pi's own test: !!reasoning", () => {
  assert.equal(supportsThinking({ reasoning: true }), true);
  assert.equal(supportsThinking({ reasoning: false }), false);
  // A row Pi could not describe reads as "cannot", the same way Pi reads it.
  assert.equal(supportsThinking({}), false);
});

ok("a switch that would drop the thinking level is worth warning about", () => {
  assert.equal(wouldDropThinking({ reasoning: false }, "high"), true);
  assert.equal(wouldDropThinking({}, "low"), true);
});

ok("nothing is dropped when there was nothing set, or the model can think", () => {
  assert.equal(wouldDropThinking({ reasoning: false }, "off"), false);
  assert.equal(wouldDropThinking({ reasoning: false }, undefined), false);
  assert.equal(wouldDropThinking({ reasoning: true }, "high"), false);
});

// ------------------------------------------------------------------- routing

const res = (o: Record<string, unknown>) => routeSlashFrame({ type: "response", ...o });

ok("a tagged get_commands answer becomes the list", () => {
  const a = res({ id: `${SLASH_ID}0`, command: "get_commands", success: true, data: PI });
  assert.equal(a.length, 1);
  assert.equal(a[0].t, "commands");
  // Every row is normalised to the same four keys, so compare what identifies
  // them rather than the absent-vs-undefined difference that normalising makes.
  assert.deepEqual(
    a[0].t === "commands" ? a[0].commands.map((c) => [c.name, c.source]) : [],
    PI.map((c) => [c.name, c.source]),
  );
});

ok("another sender's get_commands never redraws this list", () => {
  // An extension issuing the same command must not repaint the overlay.
  assert.deepEqual(res({ id: "someone-else:1", command: "get_commands", success: true, data: PI }), []);
  assert.deepEqual(res({ command: "get_commands", success: true, data: PI }), []);
});

ok("frames that are not responses, or not ours, are ignored", () => {
  assert.deepEqual(routeSlashFrame({ type: "agent_settled" }), []);
  assert.deepEqual(res({ id: `${SLASH_ID}0`, command: "get_session_stats", success: true, data: {} }), []);
});

ok("a failed read is reported rather than read as an empty list", () => {
  // An empty list and a failure look identical on screen otherwise, and the
  // overlay must keep working on the family that did answer.
  assert.deepEqual(
    res({ id: `${SLASH_ID}1`, command: "get_commands", success: false, error: "nope" }),
    [{ t: "read_failed", command: "get_commands" }],
  );
});

ok("the thinking menu comes off the wire", () => {
  assert.deepEqual(
    res({ id: `${SLASH_ID}2`, command: "get_available_thinking_levels", success: true, data: ["off", "low", "high"] }),
    [{ t: "thinking_levels", levels: ["off", "low", "high"] }],
  );
});

// -------------------------------------------------- reading Pi's shapes safely

ok("get_commands is accepted as a bare array or as { commands }", () => {
  assert.deepEqual(readCommands(PI).map((c) => c.name), PI.map((c) => c.name));
  assert.deepEqual(readCommands({ commands: PI }).map((c) => c.name), PI.map((c) => c.name));
});

ok("a row without a usable name is dropped rather than rendered blank", () => {
  const rows = [{ name: "good" }, { name: "" }, { description: "no name" }, null, "nope", 7];
  assert.deepEqual(readCommands(rows).map((c) => c.name), ["good"]);
});

ok("only the four declared fields are carried across", () => {
  const [c] = readCommands([{ name: "x", description: 7, source: "skill", sourceInfo: "s", extra: "dropped" }]);
  assert.deepEqual(c, { name: "x", description: undefined, source: "skill", sourceInfo: "s" });
});

ok("an unreadable answer is an empty list, never a crash", () => {
  for (const bad of [undefined, null, 7, "no", {}, { commands: 3 }]) {
    assert.deepEqual(readCommands(bad), []);
    assert.deepEqual(readLevels(bad), []);
  }
});

ok("thinking levels accept both shapes and drop non-strings", () => {
  assert.deepEqual(readLevels(["off", "high"]), ["off", "high"]);
  assert.deepEqual(readLevels({ levels: ["low"] }), ["low"]);
  assert.deepEqual(readLevels(["ok", "", 3, null]), ["ok"]);
});

console.log(`slash: ${n} passed`);
