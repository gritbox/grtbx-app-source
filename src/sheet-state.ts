import type { ConnState } from "./ws.ts";

/**
 * sheet-state.ts — the pure decision for what a sheet's body shows (issue #6).
 * Never-loaded (`null`) and loaded-empty (`[]`) are distinct so an in-flight
 * request can't masquerade as a real empty state, and a request that can't be
 * sent (socket not open — ws.ts drops frames silently) shows "waiting", never
 * an infinite loading state. Kept out of App.tsx so the matrix is unit-testable.
 */

export type SheetBody = "loading" | "waiting" | "empty" | "list";

/** `items` is null until the first response for this sheet ever arrives. */
export function sheetBody(conn: ConnState, items: readonly unknown[] | null): SheetBody {
  if (items === null) return conn === "open" ? "loading" : "waiting";
  return items.length === 0 ? "empty" : "list";
}
