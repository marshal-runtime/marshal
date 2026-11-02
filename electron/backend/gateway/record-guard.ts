// Marshal-owned gateway record guard.

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}
