import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const worker = process.env.MARSHAL_E2E_WORKER;
if (!worker || !/^[A-Za-z0-9_-]+$/.test(worker)) {
  throw new Error(
    "MARSHAL_E2E_WORKER must be set to a unique alphanumeric, underscore, or hyphen label",
  );
}

const dataDir = path.join(os.tmpdir(), `marshal-e2e-data-${worker}`);
const workspaceDir = path.join(dataDir, "workspace");
const externalProjectDir = path.join(dataDir, "fixtures", "ExternalProject");
const managedProjectDir = path.join(workspaceDir, "ManagedProject");
const sessionsDir = path.join(dataDir, "marshal-sessions");
const now = new Date().toISOString();

fs.rmSync(dataDir, { recursive: true, force: true });
for (const directory of [
  path.join(workspaceDir, "Scratchpad"),
  path.join(managedProjectDir, ".github", "agents"),
  path.join(externalProjectDir, ".github", "agents"),
  sessionsDir,
]) {
  fs.mkdirSync(directory, { recursive: true });
}

fs.writeFileSync(
  path.join(managedProjectDir, ".github", "agents", "managed.agent.md"),
  [
    "---",
    "name: Managed reviewer",
    "description: Reviews the managed fixture repository",
    "---",
    "Review the managed fixture repository.",
  ].join("\n"),
);
fs.writeFileSync(
  path.join(externalProjectDir, ".github", "agents", "external.agent.md"),
  [
    "---",
    "name: External reviewer",
    "description: Reviews the external fixture repository",
    "---",
    "Review the external fixture repository.",
    "Synthetic role marker: ROLE_CONTENT_MUST_NOT_PERSIST",
  ].join("\n"),
);

fs.writeFileSync(
  path.join(dataDir, "marshal-e2e-workspace-fixtures.json"),
  JSON.stringify(
    {
      version: 1,
      externalWorkspaces: [
        {
          name: "ExternalProject",
          relativePath: "fixtures/ExternalProject",
        },
      ],
    },
    null,
    2,
  ),
);

const session = {
  id: "goal-harness-seed",
  name: "Goal harness seed",
  createdAt: now,
  updatedAt: now,
  isActive: true,
  hasUnread: false,
  model: "gpt-4.1",
  soul: "default",
  backendOrigin: "copilot",
  source: "user",
  messages: [],
  permissionCards: [],
};
fs.writeFileSync(path.join(sessionsDir, `${session.id}.json`), JSON.stringify(session, null, 2));
const { messages: _messages, permissionCards: _permissionCards, ...sessionMetadata } = session;
fs.writeFileSync(
  path.join(sessionsDir, "sessions-index.json"),
  JSON.stringify(
    {
      sessions: [sessionMetadata],
      activeSessionId: session.id,
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(dataDir, "marshal-settings.json"),
  JSON.stringify(
    {
      experiments: {},
      permissions: {
        autoApproveReadOnly: false,
        allow: [],
        tools: {},
        servers: {
          filesystem: { enabled: true, autoApprove: false },
          playwright: { enabled: true, autoApprove: false },
          shell: { enabled: true, autoApprove: false },
          workServices: { enabled: true, autoApprove: false },
        },
      },
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(dataDir, "marshal-mcp-servers.json"),
  JSON.stringify({ servers: {} }, null, 2),
);

console.log(
  JSON.stringify(
    {
      worker,
      dataDir,
      workspaceDir,
      managedProjectDir,
      externalProjectDir,
      sessionId: session.id,
    },
    null,
    2,
  ),
);
