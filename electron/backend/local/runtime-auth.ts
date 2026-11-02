import { isRuntimeAuthLoginRequest } from "../../../common/runtime-auth";
import type { RuntimeAuthLoginResult, RuntimeClient } from "../runtime-contract";
import type { LoginResult } from "../types";

const DEFAULT_AUTH_TIMEOUT_MS = 120_000;
const DEFAULT_AUTH_POLL_INTERVAL_MS = 2_000;

export { isRuntimeAuthLoginRequest };

export function mapRuntimeAuthLoginResult(
  client: RuntimeClient,
  result: RuntimeAuthLoginResult,
): LoginResult {
  if (result.status === "authenticated") return {};
  const completion = waitForRuntimeAuthentication(client, result);
  if (result.method === "device-code") {
    return {
      method: result.method,
      deviceCode: result.userCode,
      verificationUri: result.verificationUri,
      completion,
    };
  }
  return {
    method: result.method,
    verificationUri: result.authorizationUrl,
    completion,
  };
}

async function waitForRuntimeAuthentication(
  client: RuntimeClient,
  result: Extract<RuntimeAuthLoginResult, { status: "pending" }>,
): Promise<void> {
  const expiresAt =
    result.method === "device-code" && result.expiresAt !== undefined
      ? result.expiresAt
      : Date.now() + DEFAULT_AUTH_TIMEOUT_MS;
  const intervalMs =
    result.method === "device-code" && result.intervalSeconds !== undefined
      ? Math.max(250, result.intervalSeconds * 1_000)
      : DEFAULT_AUTH_POLL_INTERVAL_MS;

  while (Date.now() < expiresAt) {
    // eslint-disable-next-line no-await-in-loop -- auth status is polled at the runtime-provided interval
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    // eslint-disable-next-line no-await-in-loop -- auth status is polled at the runtime-provided interval
    const status = await client.getAuthStatus();
    if (status.isAuthenticated) return;
  }
  throw new Error(`Runtime ${result.method} authentication timed out`);
}
