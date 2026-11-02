/**
 * Placement arguments and prior-view lookup for `runtimeShowUi`. A refresh
 * (by `instanceId`, or by reusing a card `slot`) swaps the render inside the
 * existing view via `replaceInstanceId`, so a fixed UI lands exactly where the
 * broken one was.
 */
import { randomUUID } from "node:crypto";

import { RUNTIME_UI_PLACEMENT_NAMES } from "../../common/runtime-ui-layout";
import type { MarshalRuntimeApi, MarshalRuntimeScope } from "./contracts";

export const SHOW_UI_SURFACES = Object.freeze([
  "inline-card",
  "panel",
  "bottom-panel",
  "tab",
  "floating",
  "fullscreen",
] as const);

const RESERVED_AUTHORED_OWNER = "marshal.react-ui";
const PLACEMENT_KEYS = ["placement", "surface", "slot", "afterMessageId", "timeoutMs"] as const;

export const SHOW_UI_PLACEMENT_PARAMETERS = {
  placement: { type: "string", enum: [...RUNTIME_UI_PLACEMENT_NAMES] },
  surface: { type: "string", enum: [...SHOW_UI_SURFACES] },
  slot: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,64}$" },
  afterMessageId: { type: "string", minLength: 1, maxLength: 256 },
  timeoutMs: { type: "integer", minimum: 1_000, maximum: 86_400_000 },
} as const;

export interface PriorAuthoredView {
  readonly instanceId: string;
  readonly applicationId: string;
  readonly surface: string;
}

/** Placement fields forwarded verbatim to ui.application.open (which validates them). */
export function placementInput(
  args: Readonly<Record<string, unknown>>,
  prior: PriorAuthoredView | undefined,
): Record<string, unknown> {
  const forwarded = Object.fromEntries(
    PLACEMENT_KEYS.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]),
  );
  if (forwarded.placement === undefined && forwarded.surface === undefined) {
    // Keep a refreshed view where it is; a new view defaults to a conversation card.
    forwarded.surface = prior?.surface ?? "inline-card";
  }
  return forwarded;
}

/** The fields that make two calls the same logical placement, for the idempotency digest. */
export function placementDigestFields(args: Readonly<Record<string, unknown>>): unknown {
  return Object.fromEntries(PLACEMENT_KEYS.map((key) => [key, args[key] ?? null]));
}

/** Finds the authored view a call refreshes: by explicit instanceId, else by card slot. */
export async function findPriorAuthoredView(
  api: MarshalRuntimeApi,
  scope: MarshalRuntimeScope,
  target: { readonly instanceId?: string; readonly slot?: string },
  signal: AbortSignal | undefined,
): Promise<PriorAuthoredView | undefined> {
  if (!target.instanceId && !target.slot) return undefined;
  const response = await api.invoke({
    ...scope,
    capability: "ui.application.list",
    input: {},
    idempotencyKey: `runtimeShowUi:list:${randomUUID()}`,
    signal,
  });
  if (!response.ok) return undefined;
  const output = asRecord(response.value.output);
  const instances = output.ok === true ? asRecord(output.value).instances : undefined;
  if (!Array.isArray(instances)) return undefined;
  for (const candidate of instances) {
    const view = asRecord(candidate);
    const matches = target.instanceId
      ? view.instanceId === target.instanceId
      : asRecord(view.anchor).slot === target.slot;
    if (!matches) continue;
    const owner = asRecord(view.owner);
    if (
      typeof view.instanceId !== "string" ||
      owner.extensionId !== RESERVED_AUTHORED_OWNER ||
      typeof owner.applicationId !== "string" ||
      typeof view.surface !== "string"
    ) {
      return undefined;
    }
    return {
      instanceId: view.instanceId,
      applicationId: owner.applicationId,
      surface: view.surface,
    };
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
