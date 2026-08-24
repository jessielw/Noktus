import type { TrickplayState, TrickplayStatus } from "../../shared/types";

const STATES: readonly TrickplayState[] = [
  "off",
  "unsupported",
  "no-manifest",
  "error",
  "ready",
];
const MAX_DETAIL_LENGTH = 300;

// The report arrives from the injected page script, so treat it as untrusted input.
export function normalizeTrickplayStatus(value: unknown): TrickplayStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("trickplay status must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const state = STATES.find((known) => known === candidate.state);
  if (!state) {
    throw new Error(`trickplay state must be one of ${STATES.join(", ")}`);
  }
  const rawDetail = candidate.detail ?? "";
  if (typeof rawDetail !== "string") {
    throw new Error("trickplay detail must be a string");
  }
  const detail = rawDetail.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL_LENGTH);
  return { state, detail };
}

export function trickplayLogLine(status: TrickplayStatus): string {
  return `Trickplay ${status.state}${status.detail ? `: ${status.detail}` : ""}`;
}
