import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import { test as base, _electron, type ElectronApplication, type Page } from "@playwright/test";

import {
  COMMAND_CENTER_REDACTION_VERSION,
  COMMAND_CENTER_SCHEMA_VERSION,
  type CommandCenterEvent,
} from "../common/command-center-contract";
import { E2E_DATA_DIR } from "../electron/mock-mode";
import {
  CHAT_CONTROLS_SESSION,
  CHAT_CONTROLS_SHORT_SESSION,
  SAMPLE_AUTOMATIONS,
  SAMPLE_HISTORY,
  SEEDED_SESSIONS,
  type SeededSession,
} from "./marshal-seed-data";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// E2E data paths within the temp dir
const SETTINGS_FILE = path.join(E2E_DATA_DIR, "marshal-settings.json");
const MCP_SERVERS_FILE = path.join(E2E_DATA_DIR, "marshal-mcp-servers.json");
const AUTOMATIONS_DIR = path.join(E2E_DATA_DIR, "marshal-automations");
const AUTOMATIONS_FILE = path.join(AUTOMATIONS_DIR, "automations.json");
const HISTORY_DIR = path.join(AUTOMATIONS_DIR, "history");
const COMMAND_CENTER_DIR = path.join(E2E_DATA_DIR, "marshal-command-center");
const COMMAND_CENTER_EVENTS_FILE = path.join(COMMAND_CENTER_DIR, "events.ndjson.enc");
const electronUserDataDirs = new Set<string>();
const electronUserDataDirByApp = new WeakMap<ElectronApplication, string>();
let electronLaunchSequence = 0;

type E2ESeededSession = SeededSession & {
  parentSessionId?: string;
  repoPath?: string;
  scopedMcp?: string[];
  scopedSkills?: string[];
  workspaceName?: string;
  workspaceIdentity?: {
    version: 1;
    device: string;
    inode: string;
    birthtimeNs: string;
  };
};

function workspaceIdentity(root: string): NonNullable<E2ESeededSession["workspaceIdentity"]> {
  const stat = fs.statSync(root, { bigint: true });
  return {
    version: 1,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
  };
}

function writeAcceptanceSkill(root: string, name: string, instructions: string): void {
  const directory = path.join(root, ".github", "skills", name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Runtime acceptance skill ${name}\n---\n${instructions}\n`,
  );
}

function seedWorkspaceCancellationScenario(sessionsDir: string): {
  readonly sessions: readonly E2ESeededSession[];
  readonly primary: Pick<
    E2ESeededSession,
    "source" | "repoPath" | "workspaceName" | "workspaceIdentity" | "scopedSkills" | "scopedMcp"
  >;
} {
  const workspaceDir = path.join(E2E_DATA_DIR, "workspace");
  fs.mkdirSync(path.join(workspaceDir, "Scratchpad"), { recursive: true });
  const explicitRootsDir = path.join(E2E_DATA_DIR, "explicit-workspace-roots");
  const explicitRoots = Object.fromEntries(
    ["marshal", "PBI", "PowerQuery"].map((name) => {
      const root = path.join(explicitRootsDir, name);
      fs.mkdirSync(root, { recursive: true });
      return [name, root];
    }),
  );
  for (const name of [
    "1eacb6d6-8975-4093-beda-9ad72deac778",
    "evidence",
    "isolated",
    "out",
    "TestResults",
  ]) {
    fs.mkdirSync(path.join(workspaceDir, name), { recursive: true });
  }
  const hiddenWorktree = path.join(E2E_DATA_DIR, "marshal-worktrees", "runtime-hidden-worktree");
  fs.mkdirSync(hiddenWorktree, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, "workspaces.json"),
    JSON.stringify(
      {
        version: 3,
        activeWorkspace: "evidence",
        workspaces: {
          Scratchpad: { origin: "scratchpad", expandedPaths: [] },
          marshal: {
            origin: "e2e-fixture",
            externalPath: explicitRoots.marshal,
            identity: workspaceIdentity(explicitRoots.marshal),
            expandedPaths: [],
          },
          PBI: {
            origin: "e2e-fixture",
            externalPath: explicitRoots.PBI,
            identity: workspaceIdentity(explicitRoots.PBI),
            expandedPaths: [],
          },
          PowerQuery: {
            origin: "e2e-fixture",
            externalPath: explicitRoots.PowerQuery,
            identity: workspaceIdentity(explicitRoots.PowerQuery),
            expandedPaths: [],
          },
          "1eacb6d6-8975-4093-beda-9ad72deac778": {
            origin: "user-created",
            identity: workspaceIdentity(
              path.join(workspaceDir, "1eacb6d6-8975-4093-beda-9ad72deac778"),
            ),
            expandedPaths: [],
          },
          evidence: {
            origin: "user-created",
            identity: workspaceIdentity(path.join(workspaceDir, "evidence")),
            expandedPaths: [],
          },
          isolated: {
            origin: "user-created",
            identity: workspaceIdentity(path.join(workspaceDir, "isolated")),
            expandedPaths: [],
          },
          out: {
            origin: "user-created",
            identity: workspaceIdentity(path.join(workspaceDir, "out")),
            expandedPaths: [],
          },
          TestResults: {
            origin: "user-created",
            identity: workspaceIdentity(path.join(workspaceDir, "TestResults")),
            expandedPaths: [],
          },
        },
      },
      null,
      2,
    ),
  );
  writeAcceptanceSkill(
    explicitRoots.marshal,
    "acceptance-marshal-skill",
    "Instructions visible only to the Marshal acceptance workspace.",
  );
  writeAcceptanceSkill(
    explicitRoots.PBI,
    "acceptance-pbi-skill",
    "Instructions visible only to the PBI acceptance workspace.",
  );
  const cancellationChild: E2ESeededSession = {
    id: "e2e-cancel-child",
    name: "Cancellation child",
    createdAt: new Date().toISOString(),
    source: "subagent",
    parentSessionId: "e2e-fresh",
    repoPath: hiddenWorktree,
    workspaceIdentity: workspaceIdentity(hiddenWorktree),
    messages: [
      {
        id: "child-task",
        role: "user",
        content: "Continue independently while the parent is cancelled.",
        timestamp: new Date().toISOString(),
      },
    ],
  };
  const secondary: E2ESeededSession = {
    id: "e2e-runtime-secondary",
    name: "Runtime secondary workspace",
    createdAt: new Date().toISOString(),
    source: "user",
    repoPath: explicitRoots.PBI,
    workspaceName: "PBI",
    workspaceIdentity: workspaceIdentity(explicitRoots.PBI),
  };
  const capacitySessions = Array.from(
    { length: 4 },
    (_, index): E2ESeededSession => ({
      id: `e2e-runtime-capacity-${index + 1}`,
      name: `Runtime capacity ${index + 1}`,
      createdAt: new Date().toISOString(),
      source: "user",
      repoPath: explicitRoots.marshal,
      workspaceName: "marshal",
      workspaceIdentity: workspaceIdentity(explicitRoots.marshal),
    }),
  );
  return {
    sessions: [cancellationChild, secondary, ...capacitySessions],
    primary: {
      source: "user",
      repoPath: explicitRoots.marshal,
      workspaceName: "marshal",
      workspaceIdentity: workspaceIdentity(explicitRoots.marshal),
      scopedSkills: ["acceptance-marshal-skill"],
      scopedMcp: ["playwright"],
    },
  };
}

function buildPaginationSessions(): E2ESeededSession[] {
  const now = Date.now();
  const definitions = [
    ...Array.from({ length: 31 }, () => "subagent" as const),
    ...Array.from({ length: 9 }, () => undefined),
    ...Array.from({ length: 31 }, () => "subagent" as const),
    ...Array.from({ length: 9 }, () => undefined),
    ...Array.from({ length: 18 }, () => "subagent" as const),
    ...Array.from({ length: 22 }, () => undefined),
    ...Array.from({ length: 40 }, () => undefined),
    undefined,
  ];
  return definitions.map((source, index) => {
    const timestamp = new Date(now - index * 1_000).toISOString();
    return {
      id: index === definitions.length - 1 ? "pagination-selected" : `pagination-${index}`,
      name: `Pagination session ${index}`,
      createdAt: timestamp,
      updatedAt: timestamp,
      source,
    };
  });
}

function electronLaunchArgs(): { args: string[]; userDataDir: string } {
  const userDataDir = path.join(
    os.tmpdir(),
    `marshal-e2e-electron-user-data-${process.pid}-${electronLaunchSequence++}`,
  );
  fs.mkdirSync(userDataDir, { recursive: true });
  electronUserDataDirs.add(userDataDir);
  return { args: [".", `--user-data-dir=${userDataDir}`], userDataDir };
}

process.once("exit", () => {
  for (const dir of electronUserDataDirs) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

function seedTestData() {
  // Wipe temp dir from any previous run, then seed fresh data.
  // E2E mode uses a temp dir (via getAppDataDir) so real user data is never touched.
  fs.rmSync(E2E_DATA_DIR, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  // Seed settings so the real SettingsManager (no stub) starts with test permissions + experiments.
  fs.writeFileSync(
    SETTINGS_FILE,
    JSON.stringify(
      {
        autoApprove: { global: false, perServer: {} },
        permissions: {
          autoApproveReadOnly: false,
          allow: [],
          tools: {},
          servers: {
            filesystem: { enabled: true, autoApprove: false },
            playwright: { enabled: true, autoApprove: false },
            shell: { enabled: true, autoApprove: false },
          },
        },
        experiments: { titleBarNavigation: true },
      },
      null,
      2,
    ),
  );
  // Seed MCP servers file so McpStore starts with built-in entries
  fs.writeFileSync(
    MCP_SERVERS_FILE,
    JSON.stringify(
      {
        servers: {
          filesystem: { builtin: true, tools: [] },
          playwright: { builtin: true, tools: [] },
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(AUTOMATIONS_FILE, JSON.stringify(SAMPLE_AUTOMATIONS, null, 2));
  fs.writeFileSync(path.join(HISTORY_DIR, "wf-1.json"), JSON.stringify(SAMPLE_HISTORY, null, 2));
  seedCommandCenterData();

  // Seed session files on disk so the real SessionManager can load them.
  // With the MockCopilotClient DI, createSDKSession runs for real — it needs
  // loadSessionData() to succeed, which reads from disk.
  const sessionsDir = path.join(E2E_DATA_DIR, "marshal-sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const paginationMode = process.env.MARSHAL_E2E_SESSION_PAGINATION === "1";
  const workspaceAcceptanceSeed =
    process.env.MARSHAL_E2E_WORKSPACE_CANCELLATION === "1"
      ? seedWorkspaceCancellationScenario(sessionsDir)
      : undefined;
  const chatControlsMode = process.env.MARSHAL_E2E_CHAT_CONTROLS === "1";
  const chatControlsSession = chatControlsMode ? CHAT_CONTROLS_SESSION : undefined;
  const chatControlsShortSession = chatControlsMode ? CHAT_CONTROLS_SHORT_SESSION : undefined;
  const seededSessions: E2ESeededSession[] = paginationMode
    ? buildPaginationSessions()
    : [
        ...SEEDED_SESSIONS.map((session) =>
          session.id === "e2e-fresh" && workspaceAcceptanceSeed
            ? { ...session, ...workspaceAcceptanceSeed.primary }
            : session,
        ),
        ...(workspaceAcceptanceSeed?.sessions ?? []),
        ...(chatControlsShortSession ? [chatControlsShortSession] : []),
        ...(chatControlsSession ? [chatControlsSession] : []),
      ];
  const activeSessionId = paginationMode
    ? "pagination-31"
    : chatControlsSession
      ? chatControlsSession.id
      : "e2e-fresh";

  for (const s of seededSessions) {
    fs.writeFileSync(
      path.join(sessionsDir, `${s.id}.json`),
      JSON.stringify({
        id: s.id,
        name: s.name,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt ?? s.createdAt,
        hasUnread: false,
        isActive: false,
        messages: s.messages ?? [],
        source: s.source,
        workspaceName: s.workspaceName,
        parentSessionId: s.parentSessionId,
        repoPath: s.repoPath,
        workspaceIdentity: s.workspaceIdentity,
        scopedSkills: s.scopedSkills,
        scopedMcp: s.scopedMcp,
        permissionCards: s.permissionCards,
      }),
    );
  }

  // Seed the sessions index so loadIndex() finds the active session
  fs.writeFileSync(
    path.join(sessionsDir, "sessions-index.json"),
    JSON.stringify({
      sessions: seededSessions.map((s) => ({
        id: s.id,
        name: s.name,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt ?? s.createdAt,
        hasUnread: false,
        isActive: s.id === activeSessionId,
        source: s.source,
        workspaceName: s.workspaceName,
        parentSessionId: s.parentSessionId,
        repoPath: s.repoPath,
        workspaceIdentity: s.workspaceIdentity,
      })),
      activeSessionId,
    }),
  );
}

function seedCommandCenterData() {
  fs.mkdirSync(COMMAND_CENTER_DIR, { recursive: true });

  const eventBase = {
    schemaVersion: COMMAND_CENTER_SCHEMA_VERSION,
    redactionVersion: COMMAND_CENTER_REDACTION_VERSION,
  } as const;
  const events: CommandCenterEvent[] = [
    {
      ...eventBase,
      type: "session.lifecycle",
      globalSeq: 0,
      ts: new Date("2026-03-07T08:00:00.000Z").getTime(),
      sessionId: "session_e2e_seed",
      lifecycle: "created",
      source: "user",
      backendOrigin: "copilot",
    },
    {
      ...eventBase,
      type: "tool.observed",
      globalSeq: 1,
      ts: new Date("2026-03-07T08:00:01.000Z").getTime(),
      toolCallId: "tool_e2e_shell",
      sessionId: "session_e2e_seed",
      toolName: "shell",
      kind: "shell",
      status: "succeeded",
      serverName: "builtin",
      argKeys: ["command"],
      argsHash: "shape_e2e",
      resultHash: "result_e2e",
    },
    {
      ...eventBase,
      type: "todo.upsert",
      globalSeq: 2,
      ts: new Date("2026-03-07T08:00:02.000Z").getTime(),
      todoId: "todo_e2e_review",
      title: "Review command center snapshot",
      status: "in_progress",
      sessionId: "session_e2e_seed",
    },
    {
      ...eventBase,
      type: "blocker.upsert",
      globalSeq: 3,
      ts: new Date("2026-03-07T08:00:03.000Z").getTime(),
      blockerId: "blocker_e2e_auth",
      label: "AuthError",
      severity: "error",
      status: "active",
      sessionId: "session_e2e_seed",
    },
  ];

  fs.writeFileSync(
    COMMAND_CENTER_EVENTS_FILE,
    events
      .map((event) => Buffer.from(JSON.stringify(event), "utf-8").toString("base64"))
      .join("\n"),
  );
}

function cleanupTestData() {
  fs.rmSync(E2E_DATA_DIR, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

export { seedTestData, cleanupTestData };

export async function launchPersistentE2EApp(options: {
  readonly userDataDir: string;
  readonly seed: boolean;
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly appRoot?: string;
}): Promise<ElectronApplication> {
  if (options.seed) seedTestData();
  else if (!fs.existsSync(SETTINGS_FILE)) {
    throw new Error(`Persistent E2E app data was not seeded: ${E2E_DATA_DIR}`);
  }
  fs.mkdirSync(options.userDataDir, { recursive: true });
  const appRoot = path.resolve(options.appRoot ?? path.resolve(__dirname, ".."));
  const app = await _electron.launch({
    args: [`--user-data-dir=${options.userDataDir}`, appRoot],
    env: {
      ...process.env,
      ...options.extraEnv,
      MARSHAL_E2E: "1",
      MARSHAL_E2E_WORKER: process.env.TEST_WORKER_INDEX ?? "0",
    },
    cwd: appRoot,
  });
  if (process.platform === "darwin") {
    await app.evaluate(({ app: electronApp }) => {
      electronApp.setAccessibilitySupportEnabled(true);
    });
  }
  return app;
}

/** Launch an Electron app, seed data, and configure platform-specific settings. */
async function launchApp(
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<ElectronApplication> {
  seedTestData();
  const launch = electronLaunchArgs();
  const app = await _electron.launch({
    args: launch.args,
    env: {
      ...process.env,
      ...extraEnv,
      MARSHAL_E2E: "1",
      MARSHAL_E2E_WORKER: process.env.TEST_WORKER_INDEX ?? "0",
    },
    cwd: path.resolve(__dirname, ".."),
  });
  electronUserDataDirByApp.set(app, launch.userDataDir);
  // Enable full keyboard navigation on macOS so Tab reaches buttons (not just text fields)
  if (process.platform === "darwin") {
    await app.evaluate(({ app: electronApp }) => {
      electronApp.setAccessibilitySupportEnabled(true);
    });
  }
  return app;
}

function seedGatewayState(): void {
  const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
  const settings = JSON.parse(raw); // oxlint-disable-line sf4/no-bare-json-parse -- local seed file
  settings.runtimeId = "gateway";
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));

  // Pre-seed a signed-in identity so tryAutoSignIn mounts the app shell
  // instead of parking on AuthScreen. `no-auth` mode skips real token
  // acquisition, which the MockGatewayWsClient doesn't need anyway.
  fs.mkdirSync(path.join(E2E_DATA_DIR, "marshal"), { recursive: true });
  fs.writeFileSync(
    path.join(E2E_DATA_DIR, "marshal-gateway-auth.json"),
    JSON.stringify({ mode: "no-auth" }, null, 2),
  );
}

async function launchGatewayApp(): Promise<ElectronApplication> {
  seedTestData();
  seedGatewayState();
  const launch = electronLaunchArgs();
  const app = await _electron.launch({
    args: launch.args,
    env: {
      ...process.env,
      MARSHAL_E2E: "1",
      MARSHAL_GATEWAY_E2E: "1",
      MARSHAL_GATEWAY_AUTH_DIR: E2E_DATA_DIR,
      MARSHAL_DEVICE_IDENTITY_PATH: path.join(E2E_DATA_DIR, "marshal", "device-identity.json"),
    },
    cwd: path.resolve(__dirname, ".."),
  });
  electronUserDataDirByApp.set(app, launch.userDataDir);
  if (process.platform === "darwin") {
    await app.evaluate(({ app: electronApp }) => {
      electronApp.setAccessibilitySupportEnabled(true);
    });
  }
  return app;
}

/** Tear down an Electron app and clean up seeded test data. */
async function teardownApp(app: ElectronApplication): Promise<void> {
  await app.close();
  cleanupTestData();
  const userDataDir = electronUserDataDirByApp.get(app);
  if (userDataDir) {
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    electronUserDataDirs.delete(userDataDir);
    electronUserDataDirByApp.delete(app);
  }
}

/** Common page setup without waiting for any particular UI. Tests that render
 *  pre-auth UI (e.g. AuthScreen, where the main nav never mounts) call this
 *  directly; tests that render the app shell compose it with waitForAppShell. */
export async function preparePageChrome(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  return page;
}

/** Blocks until the main app shell is mounted. Only meaningful post-auth. */
export async function waitForAppShell(page: Page): Promise<void> {
  await page.locator("nav[aria-label='Main navigation']").waitFor();
}

async function preparePage(app: ElectronApplication): Promise<Page> {
  const page = await preparePageChrome(app);
  await waitForAppShell(page);
  return page;
}

/**
 * Default fixture: launches a fresh Electron app per test.
 * Use for tests that mutate app state (sessions, settings, automations).
 */
export function createElectronTest(extraEnv: Readonly<Record<string, string>> = {}) {
  return base.extend<{ app: ElectronApplication; page: Page }>({
    app: async ({}, use) => {
      const app = await launchApp(extraEnv);
      await use(app);
      await teardownApp(app);
    },
    page: async ({ app }, use) => {
      const page = await preparePage(app);
      await use(page);
    },
  });
}

export const test = createElectronTest();

/**
 * Worker-scoped fixture: shares a single Electron app across all tests in a file.
 * Faster on CI by avoiding per-test Electron launch overhead.
 *
 * Only use for test files where each test resets its own state (e.g. file rewrites
 * in beforeEach). Do NOT use for tests that create/delete sessions, change settings,
 * or perform other mutations that accumulate across tests.
 *
 * Exposes `app` and `page` — same names as the per-test fixture so that test code
 * is identical regardless of which fixture it imports.
 */
export const sharedTest = base.extend<
  { app: ElectronApplication; page: Page },
  { sharedApp: ElectronApplication; sharedPage: Page }
>({
  sharedApp: [
    async ({}, use) => {
      const app = await launchApp();
      await use(app);
      await teardownApp(app);
    },
    { scope: "worker" },
  ],
  sharedPage: [
    async ({ sharedApp }, use) => {
      const page = await preparePage(sharedApp);
      await use(page);
    },
    { scope: "worker" },
  ],
  // Alias worker-scoped fixtures to the standard `app` / `page` names
  // so test code doesn't need to change.
  app: async ({ sharedApp }, use) => {
    await use(sharedApp);
  },
  page: async ({ sharedPage }, use) => {
    // Reload between tests to reset React state (navigation, selections, etc.)
    // while keeping the Electron process alive. Much faster than a full relaunch.
    await sharedPage.reload();
    await sharedPage.locator("nav[aria-label='Main navigation']").waitFor();
    await use(sharedPage);
  },
});

/** Per-test gateway-mode fixture. See `gatewaySharedTest` for the worker-scoped variant. */
export const gatewayTest = base.extend<{ app: ElectronApplication; page: Page }>({
  app: async ({}, use) => {
    const app = await launchGatewayApp();
    await use(app);
    await teardownApp(app);
  },
  page: async ({ app }, use) => {
    const page = await preparePage(app);
    await use(page);
  },
});

/** Worker-scoped gateway-mode fixture. Launches Electron with MARSHAL_E2E=1 + MARSHAL_GATEWAY_E2E=1 + a seeded Gateway runtime ID. */
export const gatewaySharedTest = base.extend<
  { app: ElectronApplication; page: Page },
  { sharedApp: ElectronApplication; sharedPage: Page }
>({
  sharedApp: [
    async ({}, use) => {
      const app = await launchGatewayApp();
      await use(app);
      await teardownApp(app);
    },
    { scope: "worker" },
  ],
  sharedPage: [
    async ({ sharedApp }, use) => {
      const page = await preparePage(sharedApp);
      await use(page);
    },
    { scope: "worker" },
  ],
  app: async ({ sharedApp }, use) => {
    await use(sharedApp);
  },
  page: async ({ sharedPage }, use) => {
    await sharedPage.reload();
    await sharedPage.locator("nav[aria-label='Main navigation']").waitFor();
    await use(sharedPage);
  },
});

export { expect } from "@playwright/test";
