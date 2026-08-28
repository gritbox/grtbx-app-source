import assert from "node:assert/strict";
import { sheetBody } from "../src/sheet-state.ts";

// never-loaded + connected → loading (an in-flight request is never a false "empty")
assert.equal(sheetBody("open", null), "loading");

// never-loaded + not connected → waiting (the request can't even be sent; never an infinite "Loading…")
assert.equal(sheetBody("connecting", null), "waiting");
assert.equal(sheetBody("reconnecting", null), "waiting");
assert.equal(sheetBody("offline", null), "waiting");

// loaded-empty → empty, regardless of connection (a real answer stays shown)
assert.equal(sheetBody("open", []), "empty");
assert.equal(sheetBody("offline", []), "empty");

// loaded with items → list, even mid-reconnect (stale cache beats a blank sheet)
assert.equal(sheetBody("open", [{ id: "a" }]), "list");
assert.equal(sheetBody("reconnecting", [{ id: "a" }]), "list");
assert.equal(sheetBody("offline", [{ id: "a" }]), "list");

console.log("sheet-state.test.ts: all assertions passed");
