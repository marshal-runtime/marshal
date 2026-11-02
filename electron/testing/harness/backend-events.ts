import type { BackendEvent, RemoteSessionEvent } from "../../backend/types";

// Throwing assertion helpers live in the automations testing domain.

function assertEventOfType<E extends { type: string }, K extends E["type"]>(
  label: string,
  e: E | undefined,
  type: K,
): Extract<E, { type: K }> {
  if (!e || e.type !== type) {
    throw new Error(`expected ${label} type "${type}", got "${e?.type ?? "undefined"}"`);
  }
  // The runtime check above narrows e.type, but TS can't propagate the
  // narrowing into `Extract<E, ...>` over a generic E.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime-checked above
  return e as Extract<E, { type: K }>;
}

export function expectBackendEvent<K extends BackendEvent["type"]>(
  e: BackendEvent | undefined,
  type: K,
): Extract<BackendEvent, { type: K }> {
  return assertEventOfType("BackendEvent", e, type);
}

export function expectRemoteSessionEvent<K extends RemoteSessionEvent["type"]>(
  e: RemoteSessionEvent | undefined,
  type: K,
): Extract<RemoteSessionEvent, { type: K }> {
  return assertEventOfType("RemoteSessionEvent", e, type);
}
