import type { StatusLogEntry } from "../plugin-data";

export function isErrorLogMsg(msg: string): boolean {
  return /^\s*Error:/i.test(msg);
}

function titleState(state: string): string {
  if (!state) return "Ready";
  return state.charAt(0).toUpperCase() + state.slice(1);
}

/** One-line settings headline. Healthy sync is just "Synced", not "synced — Synced". */
export function statusHeadline(state: string, detail?: string | null): string {
  if (state === "synced") return "Status: Synced";
  const d = (detail ?? "").trim();
  if (state === "error") return d ? `Status: Error — ${d}` : "Status: Error";
  if (!d || d.toLowerCase() === state.toLowerCase()) return `Status: ${titleState(state)}`;
  return `Status: ${state} — ${d}`;
}

/** lastError is a live failure only. After a good sync it must not stay on screen. */
export function showLastError(state: string, lastError: string | null | undefined): string | null {
  if (state !== "error") return null;
  const msg = (lastError ?? "").trim();
  return msg || null;
}

/** Hide recovered Error: lines once the current state is healthy. */
export function visibleStatusLog(
  entries: StatusLogEntry[],
  state: string,
  limit = 8
): StatusLogEntry[] {
  const list = state === "error" ? entries : entries.filter((e) => !isErrorLogMsg(e.msg));
  return list.slice(-limit);
}
