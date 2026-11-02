import { createHash } from "node:crypto";

import type { Message } from "../session-store";

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeJson(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalizeJson(item)]),
  );
}

export function computeSessionWorkerBaseDigest(messages: Message[]): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeJson(messages)))
    .digest("hex");
}
