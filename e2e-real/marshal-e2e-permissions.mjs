// Marshal-owned real-account harness.
/**
 * Shared permission configurations for E2E integration tests.
 *
 * The permission pipeline (permission-policy.ts) evaluates requests through a
 * 10-step priority chain. These configs target specific steps:
 *
 *   autoApproveReadOnly → Step 6 (read-only shell + READ_ONLY_CUSTOM_TOOLS)
 *   tools               → Step 7a (structured tool auto-approve via group/tool key)
 *   servers              → Step 5 (server-level auto-approve)
 *   allow                → Step 7 (shell pattern whitelist)
 */

/**
 * Permissions seeded by the runner before any test suite executes.
 * Principle: autoApproveReadOnly covers all reads; explicit entries only for writes.
 */
export const E2E_TEST_PERMISSIONS = {
  autoApproveReadOnly: true,
  allow: [],
  tools: {
    // ── App write tools (tests 12, 14, 15, 16, 17, 20, 22, 24, 29) ──
    // Group keys cover all CRUD + run operations for each app subsystem.
    "tool:memory": true,
    "tool:automations": true,
    "tool:skills": true,
    "tool:heartbeat": true,
    "tool:models": true,
    "tool:settings": true,
    "tool:sessions": true,
    "tool:runtimeSearch": true,
    "tool:runtimeInvoke": true,
    "tool:code.index.status": true,
  },
  servers: {
    filesystem: { enabled: true, autoApprove: true }, // tests 09, 11, 28 (kind: "mcp" with serverName)
    playwright: { enabled: true, autoApprove: true }, // test 04 (kind: "mcp" with serverName)
    shell: { enabled: true, autoApprove: true }, // tests 03, 05 — search-web is an SDK shell cmd with unpredictable format
    // SDK permission kinds that arrive without a serverName — pipeline falls back to kind as key
    write: { enabled: true, autoApprove: true }, // filesystem writes arrive as kind:"write" (test 09, 11)
    url: { enabled: true, autoApprove: true }, // browser URL visits arrive as kind:"url" (test 04)
  },
};

/**
 * No auto-approve — forces permission cards to appear.
 * Used by tests that verify permission blocking behavior (18, 21, 23).
 */
export const NO_AUTO_APPROVE_PERMISSIONS = {
  autoApproveReadOnly: false,
  allow: [],
  tools: {},
  servers: {
    filesystem: { enabled: true, autoApprove: false },
    playwright: { enabled: true, autoApprove: false },
    shell: { enabled: true, autoApprove: false },
    workServices: { enabled: true, autoApprove: false },
    write: { enabled: true, autoApprove: false },
    url: { enabled: true, autoApprove: false },
  },
};
