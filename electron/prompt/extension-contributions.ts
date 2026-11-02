/**
 * Per-extension prompt contributions, dynamically assembled from the
 * installed extension inventory — no hardcoded extension content.
 * Contract: harness-audit-2026-09-09/prompt-implementation/runtime-contract.md
 * (shapes verified against the runtime's RuntimeExtensionLifecycleRecord).
 *
 * Rendering is owned by the runtime's canonical helper
 * (`buildExtensionPromptSections` / `renderExtensionPromptBlock` from
 * `@marshal/runtime/extensions`, @417f383+): healthy → full guidance block for
 * EVERY healthy extension (no total-cap shedding; boundedness comes from the
 * runtime's per-field caps), blocked → one-line degraded entry with the first
 * block reason, disabled/not-installed → nothing. This module only adapts the
 * host's snapshot transport into the record fields the helper reads — it must
 * not fork the rendering rules (contract.md single-ownership).
 */
import {
  buildExtensionPromptSections,
  renderExtensionPromptBlock,
  type RuntimeExtensionLifecycleRecord,
} from "@marshal/runtime/extensions";

export interface ExtensionPromptGuidance {
  purpose?: string;
  when?: string;
  recipe?: string;
  boundaries?: string;
}

export type ExtensionPromptHealth = "healthy" | "blocked" | "disabled" | "not-installed";

export interface ExtensionPromptContribution {
  identity: string;
  version: string;
  health: ExtensionPromptHealth;
  /** First block reason message, for degraded notes on `blocked` records. */
  blockReason?: string;
  /** Catalog strings — the guaranteed-plain fallback when no authored purpose exists. */
  title?: string;
  description?: string;
  /** Authored guidance copied verbatim from the manifest (runtime-validated). */
  guidance?: ExtensionPromptGuidance;
  /** Manifest capability-name PREFIXES (not full names). */
  capabilityPrefixes: readonly string[];
}

/**
 * Deterministic render via the canonical runtime helper. Returns "" when
 * nothing renders so the assembler can omit the block entirely; output is
 * stable for identical inputs (cache-friendly between extension-change
 * events). The helper reads only identity/version/health/blockReasons/title/
 * description/agentGuidance/contributedCapabilityPrefixes, which is the exact
 * surface this adapter populates — the cast below is confined here and pinned
 * by the parity test in assemble.test.ts.
 */
export function buildExtensionPromptSection(
  contributions: ReadonlyArray<ExtensionPromptContribution>,
): string {
  const records = contributions.map((contribution) => {
    const record: Partial<RuntimeExtensionLifecycleRecord> = {
      identity: contribution.identity,
      version: contribution.version,
      health: contribution.health,
      blockReasons: contribution.blockReason
        ? [{ code: "host-snapshot", message: contribution.blockReason }]
        : [],
      ...(contribution.title === undefined ? {} : { title: contribution.title }),
      ...(contribution.description === undefined ? {} : { description: contribution.description }),
      ...(contribution.guidance === undefined ? {} : { agentGuidance: contribution.guidance }),
      contributedCapabilityPrefixes: contribution.capabilityPrefixes,
    };
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the canonical renderer reads only the fields populated above (its documented rule set); the host snapshot transport cannot carry full lifecycle records across the IPC-shaped provider boundary, and the parity tests in assemble.test.ts pin the rendered output against drift
    return record as RuntimeExtensionLifecycleRecord;
  });
  return renderExtensionPromptBlock(buildExtensionPromptSections(records));
}

/**
 * Map a runtime extension lifecycle record to a prompt contribution.
 * Structurally tolerant: `agentGuidance` ships with the repinned runtime
 * (prompt-implementation/runtime-contract.md §2); until the repin lands the
 * field is simply absent and blocks auto-derive from title/description.
 */
export function toExtensionPromptContribution(record: {
  readonly identity: string;
  readonly version: string;
  readonly health?: "healthy" | "blocked" | "disabled" | "not-installed";
  readonly status?: string;
  readonly blockReasons?: readonly { readonly message?: string }[];
  readonly title?: string;
  readonly description?: string;
  readonly contributedCapabilityPrefixes?: readonly string[];
  readonly agentGuidance?: ExtensionPromptGuidance;
}): ExtensionPromptContribution {
  const health: ExtensionPromptHealth =
    record.health ?? (record.status === "enabled" ? "healthy" : "disabled");
  return {
    identity: record.identity,
    version: record.version,
    health,
    blockReason: record.blockReasons?.[0]?.message,
    title: record.title,
    description: record.description,
    guidance: record.agentGuidance,
    capabilityPrefixes: record.contributedCapabilityPrefixes ?? [],
  };
}
