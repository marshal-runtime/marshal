import { describe, expect, it } from "vitest";

import { assembleMarshalSystemPrompt, type AssembleMarshalPromptInput } from "./assemble";
import {
  buildExtensionPromptSection,
  toExtensionPromptContribution,
  type ExtensionPromptContribution,
} from "./extension-contributions";
import { MARSHAL_BEHAVIOR_CORE } from "./sections/behavior-core";

// Section sentinels: stable phrases owned by exactly one section.
const CORE_SENTINEL = "# Marshal"; // behavior core heading
const CORE_XPIA_SENTINEL = "External content and untrusted input";
const HOST_SENTINEL = "setSessionTodos";
const RUNTIME_SENTINEL = "runtimeSearch";
const SWARM_SENTINEL = "recursive software-engineering swarm";

function baseInput(
  overrides: Partial<AssembleMarshalPromptInput> = {},
): AssembleMarshalPromptInput {
  return {
    role: { runtimeAgentRole: undefined, isSubagent: false, isWorkspaceScopedMain: false },
    includeClaudeTooling: true,
    includeHostTools: true,
    runtimeAvailable: true,
    extensionContributions: [],
    availability: { browserEnabled: true },
    sessionContext: "",
    ...overrides,
  };
}

function contribution(
  overrides: Partial<ExtensionPromptContribution> = {},
): ExtensionPromptContribution {
  return {
    identity: "@example/ext",
    version: "1.0.0",
    health: "healthy",
    capabilityPrefixes: ["example."],
    ...overrides,
  };
}

describe("assembleMarshalSystemPrompt", () => {
  it("orders sections deterministically: core, adapter, host, runtime, role delta", () => {
    const { content } = assembleMarshalSystemPrompt(baseInput());
    const coreAt = content.indexOf(CORE_SENTINEL);
    const hostAt = content.indexOf(HOST_SENTINEL);
    const runtimeAt = content.indexOf(RUNTIME_SENTINEL);
    const roleAt = content.indexOf("## Role: orchestrating main session");
    expect(coreAt).toBe(0);
    expect(hostAt).toBeGreaterThan(coreAt);
    expect(runtimeAt).toBeGreaterThan(0);
    expect(roleAt).toBeGreaterThan(hostAt);
  });

  it("adds the code-search rule only when a healthy extension provides knowledge.* capabilities", () => {
    const rule = "## Code questions: search the knowledge index first";
    const brain = contribution({
      identity: "@marshal/brain",
      capabilityPrefixes: ["knowledge.", "memory."],
    });
    const withBrain = assembleMarshalSystemPrompt(
      baseInput({ extensionContributions: [brain] }),
    ).content;
    expect(withBrain).toContain(rule);
    expect(withBrain.indexOf(rule)).toBeLessThan(
      withBrain.indexOf("## Installed runtime extensions"),
    );
    for (const input of [
      baseInput(),
      baseInput({ extensionContributions: [contribution()] }),
      baseInput({ extensionContributions: [{ ...brain, health: "blocked" }] }),
      baseInput({ extensionContributions: [brain], runtimeAvailable: false }),
    ]) {
      expect(assembleMarshalSystemPrompt(input).content).not.toContain(rule);
    }
  });

  it("describes TypeScript execution according to the host's execution mode", () => {
    const brokered = assembleMarshalSystemPrompt(baseInput()).content;
    const trusted = assembleMarshalSystemPrompt(baseInput({ trustedTypeScript: true })).content;

    expect(brokered).toContain("## Brokered TypeScript");
    expect(brokered).toContain("there is no Node filesystem, network, or process access");
    expect(brokered).not.toContain("## Full TypeScript execution");

    expect(trusted).toContain("## Full TypeScript execution");
    expect(trusted).not.toContain("## Brokered TypeScript");
    expect(trusted).not.toContain("there is no Node filesystem, network, or process access");
    expect(trusted).toContain("## Output data vs user-facing UI");
    expect(`${brokered}${trusted}`).not.toContain("%%");
  });

  it("is byte-deterministic for identical inputs", () => {
    const a = assembleMarshalSystemPrompt(baseInput({ sessionContext: "tail" }));
    const b = assembleMarshalSystemPrompt(baseInput({ sessionContext: "tail" }));
    expect(a.content).toBe(b.content);
  });

  it("keeps the stable prefix identical across roles (caching contract)", () => {
    const main = assembleMarshalSystemPrompt(baseInput()).content;
    const swarm = assembleMarshalSystemPrompt(
      baseInput({
        role: { runtimeAgentRole: "worker", isSubagent: true, isWorkspaceScopedMain: false },
      }),
    ).content;
    // Everything before the role delta must be shared byte-for-byte.
    const prefixEnd = main.indexOf("## Role:");
    const swarmPrefixEnd = swarm.indexOf(SWARM_SENTINEL);
    expect(prefixEnd).toBeGreaterThan(0);
    expect(swarmPrefixEnd).toBeGreaterThan(0);
    expect(main.slice(0, prefixEnd)).toBe(swarm.slice(0, prefixEnd));
  });

  it("swarm roles keep the shared core (no whole-prompt swap): XPIA rules survive", () => {
    const { content } = assembleMarshalSystemPrompt(
      baseInput({
        role: { runtimeAgentRole: "reviewer", isSubagent: true, isWorkspaceScopedMain: false },
      }),
    );
    expect(content).toContain(CORE_XPIA_SENTINEL);
    expect(content).toContain(SWARM_SENTINEL);
  });

  it("covers every role with core + additive delta", () => {
    const roles: Array<[AssembleMarshalPromptInput["role"], string]> = [
      [
        { runtimeAgentRole: undefined, isSubagent: false, isWorkspaceScopedMain: false },
        "## Role: orchestrating main session",
      ],
      [
        { runtimeAgentRole: undefined, isSubagent: false, isWorkspaceScopedMain: true },
        "## Role: workspace-scoped main session",
      ],
      [
        { runtimeAgentRole: undefined, isSubagent: true, isWorkspaceScopedMain: false },
        "## Role: delegated subagent",
      ],
      [
        { runtimeAgentRole: "worker", isSubagent: true, isWorkspaceScopedMain: false },
        SWARM_SENTINEL,
      ],
      [
        { runtimeAgentRole: "swarm", isSubagent: false, isWorkspaceScopedMain: false },
        SWARM_SENTINEL,
      ],
      [
        { runtimeAgentRole: "reconciler", isSubagent: true, isWorkspaceScopedMain: false },
        SWARM_SENTINEL,
      ],
    ];
    for (const [role, marker] of roles) {
      const { content } = assembleMarshalSystemPrompt(baseInput({ role }));
      expect(content.startsWith(CORE_SENTINEL)).toBe(true);
      expect(content).toContain(marker);
    }
  });

  it("omits provider/host/runtime guidance for tool-free roles and unavailable surfaces", () => {
    const { content } = assembleMarshalSystemPrompt(
      baseInput({
        includeClaudeTooling: false,
        includeHostTools: false,
        runtimeAvailable: false,
      }),
    );
    expect(content).not.toContain(HOST_SENTINEL);
    expect(content).not.toContain(RUNTIME_SENTINEL);
    expect(content).toContain(CORE_SENTINEL);
  });

  it("gates browser guidance on availability (no eager unavailable guidance)", () => {
    const on = assembleMarshalSystemPrompt(baseInput()).content;
    expect(on).toContain("Browser Control and Web Browsing");

    const off = assembleMarshalSystemPrompt(
      baseInput({ availability: { browserEnabled: false } }),
    ).content;
    expect(off).not.toContain("Browser Control and Web Browsing");
  });

  it("single ownership: memory/skill operating guidance lives in the host section, not the core", () => {
    // Core defers operational discipline to the tool owner…
    expect(MARSHAL_BEHAVIOR_CORE).not.toContain("recall {query}");
    expect(MARSHAL_BEHAVIOR_CORE).not.toContain("getSkill");
    expect(MARSHAL_BEHAVIOR_CORE).toContain("belongs to the section that documents");
    // …and the host section owns it exactly once in the assembled output.
    const { content } = assembleMarshalSystemPrompt(baseInput());
    expect(content.split("When to consult memory").length - 1).toBe(1);
    expect(content.split("getSkill {name}").length - 1).toBe(1);
  });
});

describe("runtime section matches the shipped UI authoring surface", () => {
  const { content } = assembleMarshalSystemPrompt(baseInput());

  it("carries no pre-authored-placement boundary contradicting the authored loop", () => {
    // The stale v2 boundary told agents new UI was impossible without an
    // extension — contradicting the authored compile→render→place loop that
    // now ships. Regression-pin its absence and the presence of the real path.
    expect(content).not.toContain("registering a *new* application requires an extension");
    expect(content).not.toContain("which is outside these capabilities");
    expect(content).toContain('extensionId: "marshal.react-ui"');
    expect(content).toContain("ui.applications.list");
    expect(content).toContain("ui.compile");
    // ui.authored.* is documented as scoped STATE records, never as a
    // placement/registration route (host does not enable authoredUiPromotion).
    expect(content).toContain("ui.authored.write");
    expect(content).toContain("NOT a placement or registration route");
  });

  it("approval-required guidance binds the grant to the original idempotency key", () => {
    // Verified live (preview session + reviewer receipts): a retry with a new
    // key mints a fresh approval and strands the granted one. Exactly one
    // authoritative rule, referenced (not duplicated) by the callAction line.
    expect(content).toContain("bound to your idempotency key");
    expect(content).toContain("retry the same logical operation with the SAME key");
    expect(content.split("strands the one the user already granted").length - 1).toBe(1);
    expect(content).toContain("same rule as `approval-required` above");
  });

  it("action-bridge contracts match the host probe (result envelope, module input, testability)", () => {
    // Verified by the isolated host probe (real click through the sandboxed
    // bridge): callAction resolves {status, output, receipt}; module targets
    // receive the schema-shaped JSON input; browser entropy is live.
    expect(content).toContain("UiActionResult");
    // Proven detours from the Joke Machine build: wrong module root (ENOENT)
    // and dots in action ids — both now stated from verified source/behavior.
    expect(content).toContain("resolves against the RUNTIME's own workspace root");
    expect(content).toContain("[a-zA-Z0-9_-]+");
    expect(content).toContain("bounded summaries");
    expect(content).not.toMatch(/workspace_file[^.]*\/Users\//);
    expect(content).toContain("take the action's payload from `result.output`");
    expect(content).toContain("plain JSON value matching `inputSchema`");
    // No absolutes about untestable UI, no frozen-entropy or blanket-unwrap teachings.
    expect(content).not.toContain("no way to test");
    expect(content).not.toContain("only the user can click");
    expect(content).not.toMatch(/frozen (entropy|Date|clock)/i);
    expect(content).not.toContain("recursively unwrap");
  });

  it("describes authoring-profile semantics exactly as the shipped compiler implements them", async () => {
    // Grounded against the installed runtime pack, not prose: framework
    // imports are compiler-intrinsic; packageImports is the profile's
    // allowlist for ADDITIONAL packages and the standards profile grants none.
    const ui = await import("@marshal/agent-runtime-ui");
    const profile = (
      ui as { STANDARDS_ONLY_UI_PROFILE: { id: string; packageImports: readonly string[] } }
    ).STANDARDS_ONLY_UI_PROFILE;
    expect(profile.id).toBe("marshal-standards");
    expect(profile.packageImports).toEqual([]);
    expect(content).toContain("Framework imports are intrinsic to the compiler");
    expect(content).toContain("`marshal-standards` profile allows none");
    // The old claim attributed react availability to the profile — gone.
    expect(content).not.toContain("The default standards profile allows `react`");
    // Dynamic discovery stays mandatory.
    expect(content).toContain("ui.authoring.profiles.list");
    expect(content).toContain("Never hardcode availability");
  });
});

describe("buildExtensionPromptSection", () => {
  it("renders every healthy extension, sorted, with prefix-correct discovery lines", () => {
    const section = buildExtensionPromptSection([
      contribution({ identity: "@z/last", capabilityPrefixes: ["z.things."] }),
      contribution({
        identity: "@a/first",
        guidance: {
          purpose: "Does A things",
          when: "When A is needed",
          recipe: "a.things.create then a.things.get",
          boundaries: "Never for B",
        },
        capabilityPrefixes: ["a.things."],
      }),
    ]);
    expect(section.indexOf("@a/first")).toBeLessThan(section.indexOf("@z/last"));
    expect(section).toContain("purpose: Does A things");
    expect(section).toContain("recipe: a.things.create then a.things.get");
    // Prefixes are searched by QUERY, never exact-name looked up
    // (canonical helper wording, pinned since runtime 417f383).
    expect(section).toContain('runtimeSearch {query: "a.things."}');
    expect(section).not.toMatch(/runtimeSearch \{name:\s*"a\.things\."\}/);
  });

  it("renders blocked extensions as a short degraded note with the reason", () => {
    const section = buildExtensionPromptSection([
      contribution({
        identity: "@b/blocked",
        health: "blocked",
        blockReason: "missing dependency @x/y",
      }),
    ]);
    expect(section).toContain("@b/blocked v1.0.0 — unavailable: missing dependency @x/y");
    expect(section).not.toContain("purpose:");
  });

  it("excludes disabled and not-installed extensions entirely", () => {
    const section = buildExtensionPromptSection([
      contribution({ identity: "@d/disabled", health: "disabled" }),
      contribution({ identity: "@n/gone", health: "not-installed" }),
    ]);
    expect(section).toBe("");
  });

  it("rebuild reflects enable/disable transitions deterministically", () => {
    const enabled = buildExtensionPromptSection([contribution()]);
    const disabled = buildExtensionPromptSection([contribution({ health: "disabled" })]);
    expect(enabled).toContain("@example/ext");
    expect(disabled).toBe("");
    // Re-enable returns the identical block (cache-stable).
    expect(buildExtensionPromptSection([contribution()])).toBe(enabled);
  });

  it("never sheds a healthy extension regardless of count", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      contribution({
        identity: `@many/ext-${String(i).padStart(2, "0")}`,
        capabilityPrefixes: [`m${i}.`],
      }),
    );
    const section = buildExtensionPromptSection(many);
    for (const item of many) expect(section).toContain(item.identity);
    expect(section).not.toContain("+ more extensions");
  });
});

describe("toExtensionPromptContribution", () => {
  it("maps lifecycle records and tolerates the pre-repin shape (no agentGuidance)", () => {
    const preRepin = toExtensionPromptContribution({
      identity: "@old/ext",
      version: "0.1.0",
      status: "enabled",
      title: "Old Extension",
      description: "Legacy record without guidance",
    });
    expect(preRepin.health).toBe("healthy");
    expect(preRepin.guidance).toBeUndefined();
    const rendered = buildExtensionPromptSection([preRepin]);
    expect(rendered).toContain("purpose: Legacy record without guidance");

    const blocked = toExtensionPromptContribution({
      identity: "@new/ext",
      version: "1.2.0",
      health: "blocked",
      blockReasons: [{ message: "contract conflict" }],
      contributedCapabilityPrefixes: ["new."],
      agentGuidance: { purpose: "New things" },
    });
    expect(blocked.health).toBe("blocked");
    expect(blocked.blockReason).toBe("contract conflict");
  });
});
