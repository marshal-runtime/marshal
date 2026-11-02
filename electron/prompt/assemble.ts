import { buildBrowserGuidanceSection, VISUALIZATION_GUIDANCE } from "./availability-sections";
import {
  buildExtensionPromptSection,
  type ExtensionPromptContribution,
} from "./extension-contributions";
import { buildRoleDelta, type PromptRoleContext } from "./role-deltas";
import { MARSHAL_BEHAVIOR_CORE } from "./sections/behavior-core";
import { CLAUDE_NATIVE_TOOLING } from "./sections/claude-tooling";
import {
  buildCodeIntelligenceSection,
  hasCodeIntelligence,
} from "./sections/code-intelligence-section";
import { MARSHAL_HOST_TOOLS } from "./sections/host-tools";
import { LEAN_BEHAVIOR_CORE } from "./sections/lean-behavior-core";
import { buildLeanClaudeTooling } from "./sections/lean-claude-tooling";
import { buildLeanHostTools } from "./sections/lean-host-tools";
import { buildMarshalRuntimeSection } from "./sections/runtime-section";

/**
 * Deterministic assembly of the Marshal-owned full-replacement system prompt.
 *
 * Ordering contract (caching + review surface — do not reorder casually):
 *   [1 behavior core][2 provider tooling][3 host tools][4 runtime section]
 *   [role delta][availability-gated guidance][extension contributions]
 *   [session context tail]
 * Layers 1–4 are byte-identical across every session of a given provider, so
 * they form the maximal shared prefix; the role delta is per-role constant;
 * everything after is session-dependent. Rebuilds happen only at safe
 * boundaries (session create/resume/refresh) — never mid-turn.
 */
export interface AssembleMarshalPromptInput {
  role: PromptRoleContext;
  /** Claude tooling is assembled here; Cursor appends its adapter-owned contract later. */
  includeClaudeTooling: boolean;
  /** Host tool guidance; false for tool-free roles that can call nothing. */
  includeHostTools: boolean;
  /** Runtime bridge available to this session (runtime self-tools exposed). */
  runtimeAvailable: boolean;
  /** Full-Node TypeScript execution is enabled on this host (trusted-typescript.ts). */
  trustedTypeScript?: boolean;
  /** Lean prompt (see ./lean-prompt.ts); omitted/false reproduces the legacy text exactly. */
  lean?: boolean;
  /** Stage B (see ./lean-prompt.ts): lean behavior core, plus deeper section trims when `lean` is also on. */
  leanCore?: boolean;
  extensionContributions: ReadonlyArray<ExtensionPromptContribution>;
  availability: {
    browserEnabled: boolean;
  };
  /**
   * Pre-built dynamic tail: repo customizations, skills index, soul,
   * workspace memory, memory prompt + provenance, workspace/subagent
   * contexts, relay/exclusive instructions. Built by the caller from the
   * same providers the legacy composer uses.
   */
  sessionContext: string;
}

export function assembleMarshalSystemPrompt(input: AssembleMarshalPromptInput): {
  content: string;
} {
  const lean = input.lean === true;
  const leanCore = input.leanCore === true;
  const deep = lean && leanCore;
  const sections: string[] = [(leanCore ? LEAN_BEHAVIOR_CORE : MARSHAL_BEHAVIOR_CORE).trim()];
  if (input.includeClaudeTooling) {
    sections.push(
      (lean
        ? buildLeanClaudeTooling(CLAUDE_NATIVE_TOOLING, { deep })
        : CLAUDE_NATIVE_TOOLING
      ).trim(),
    );
  }
  if (input.includeHostTools) {
    sections.push(
      (lean ? buildLeanHostTools(MARSHAL_HOST_TOOLS, { deep }) : MARSHAL_HOST_TOOLS).trim(),
    );
  }
  if (input.runtimeAvailable) {
    sections.push(
      buildMarshalRuntimeSection({
        trustedTypeScript: input.trustedTypeScript === true,
        lean,
        leanCore,
      }).trim(),
    );
  }
  sections.push(buildRoleDelta(input.role).trim());

  const availabilityBlocks = [
    buildCodeIntelligenceSection(
      input.runtimeAvailable && hasCodeIntelligence(input.extensionContributions),
    ),
    buildBrowserGuidanceSection(!input.availability.browserEnabled),
    VISUALIZATION_GUIDANCE,
  ]
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  sections.push(...availabilityBlocks);

  const extensionSection = buildExtensionPromptSection(input.extensionContributions);
  if (extensionSection) sections.push(extensionSection);

  const tail = input.sessionContext.trim();
  if (tail) sections.push(tail);

  return { content: sections.join("\n\n") };
}
