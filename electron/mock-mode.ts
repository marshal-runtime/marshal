import { tmpdir } from "node:os";
import path from "node:path";

let _isMockMode = process.env.MARSHAL_E2E === "1";

// Each Playwright worker gets its own data dir to allow parallel execution.
// Two env vars carry the worker index into different processes:
//   - TEST_WORKER_INDEX: set by Playwright in the test-runner process (used by seedTestData)
//   - MARSHAL_E2E_WORKER: passed explicitly by launchApp() into the Electron child process
// In the Electron child, ...process.env propagates TEST_WORKER_INDEX too, so both
// are usually present. We read whichever is available; they always carry the same value.
interface E2EWorkerEnvironment {
  [key: string]: string | undefined;
  TEST_WORKER_INDEX?: string;
  MARSHAL_E2E_WORKER?: string;
}

export function resolveE2EDataDir(env: E2EWorkerEnvironment = process.env): string {
  const workerIndex = env.TEST_WORKER_INDEX ?? env.MARSHAL_E2E_WORKER ?? "";
  const workerSuffix = workerIndex ? `-${workerIndex}` : "";
  return path.join(tmpdir(), `marshal-e2e-data${workerSuffix}`);
}

export const E2E_DATA_DIR = resolveE2EDataDir();

export function isMockMode(): boolean {
  return _isMockMode;
}

export function setMockMode(enabled: boolean): void {
  _isMockMode = enabled;
}
