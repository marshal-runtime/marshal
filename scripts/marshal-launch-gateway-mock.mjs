// Manual counterpart to e2e/marshal-fixtures.ts:launchGatewayApp. Seeds the E2E data
// dir + signed-in gateway identity, then launches Electron with the mock-WS
// flags so the renderer takes the gateway branch.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = join(tmpdir(), "marshal-e2e-data");
const SETTINGS_FILE = join(DATA_DIR, "marshal-settings.json");
const MCP_SERVERS_FILE = join(DATA_DIR, "marshal-mcp-servers.json");
const AUTOMATIONS_DIR = join(DATA_DIR, "marshal-automations");
const SESSIONS_DIR = join(DATA_DIR, "marshal-sessions");
const MARSHAL_DIR = join(DATA_DIR, "marshal");
const DEVICE_IDENTITY_PATH = join(MARSHAL_DIR, "device-identity.json");

rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(join(AUTOMATIONS_DIR, "history"), { recursive: true });
mkdirSync(SESSIONS_DIR, { recursive: true });
mkdirSync(MARSHAL_DIR, { recursive: true });

writeFileSync(
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
          workServices: { enabled: true, autoApprove: false },
        },
      },
      runtimeId: "gateway",
    },
    null,
    2,
  ),
);

writeFileSync(
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

writeFileSync(join(AUTOMATIONS_DIR, "automations.json"), "[]\n");
writeFileSync(
  join(SESSIONS_DIR, "sessions-index.json"),
  JSON.stringify({ sessions: [], activeSessionId: null }, null, 2),
);
writeFileSync(
  join(DATA_DIR, "marshal-gateway-auth.json"),
  JSON.stringify({ mode: "no-auth" }, null, 2),
);

// ELECTRON_RUN_AS_NODE may be inherited from a parent Electron host (VS Code,
// Marshal itself); clearing it ensures we get the chromium runtime.
delete process.env.ELECTRON_RUN_AS_NODE;

const require = createRequire(import.meta.url);
const electronPath = require("electron");

console.log(`[gateway-mock] data dir: ${DATA_DIR}`);
console.log(`[gateway-mock] device identity: ${DEVICE_IDENTITY_PATH}`);
console.log(`[gateway-mock] launching electron with MARSHAL_E2E=1 + MARSHAL_GATEWAY_E2E=1`);

try {
  execFileSync(electronPath, [".", "--no-sandbox", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      MARSHAL_E2E: "1",
      MARSHAL_GATEWAY_E2E: "1",
      MARSHAL_GATEWAY_AUTH_DIR: DATA_DIR,
      MARSHAL_DEVICE_IDENTITY_PATH: DEVICE_IDENTITY_PATH,
    },
  });
} catch (err) {
  process.exit(err.status ?? 1);
}
