import type { IBackendProvider } from "../../backend/types";
import type { ClientFactory } from "../../backend/types";

/**
 * No-op client factory for unit tests.
 * Tests that need a real (mocked) client should provide their own factory.
 */
export const stubClientFactory: ClientFactory = async () => {
  throw new Error("stubClientFactory: initClient() should not be called in this test");
};

/**
 * Creates a CopilotBackend with a mock client factory for tests.
 *
 * WARNING: MUST be called AFTER vi.mock() calls are in place — uses dynamic
 * import to ensure mocks are applied before CopilotBackend loads its
 * dependencies. Calling this at module scope will bypass mocks.
 *
 * This is the standard way to construct a SessionManager in tests — it uses the
 * real CopilotBackend so that existing mock patterns (setting `client` via
 * SessionTestAccess, creating mock SDK sessions) continue to work.
 */
export async function createTestBackend(
  clientFactory: ClientFactory = stubClientFactory,
): Promise<IBackendProvider> {
  const { CopilotBackend } = await import("../../backend/copilot/provider");
  return new CopilotBackend({ workspaceDir: "/test/workspace", clientFactory });
}
