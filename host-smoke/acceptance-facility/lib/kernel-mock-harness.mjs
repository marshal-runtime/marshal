import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRuntimeKernel } from "@marshal/runtime";

import { createDeclaredPermissionBroker } from "./declared-permission-broker.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_APP_ROOT = path.resolve(__dirname, "..", "sample-app");
const SAMPLE_APP_FILES = ["manifest.mjs", "capability-provider.mjs", "index.html"];

/** Deterministic integrity hash over the sample app's checked-in bytes, so kernel-mock receipts can tie evidence to a "revision" the same way (a) ties installed evidence to an integrity hash. */
export function sampleAppIntegrity() {
  const hash = createHash("sha256");
  for (const relative of SAMPLE_APP_FILES) {
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(SAMPLE_APP_ROOT, relative)));
    hash.update("\0");
  }
  return `sha256-${hash.digest("hex")}`;
}

const principal = { id: "acceptance-facility", kind: "service" };

function invocationContext(overrides = {}) {
  return { principal, ...overrides };
}

/**
 * Builds a portable RuntimeKernel with the sample app's capability provider
 * registered behind a declared-only permission broker (see
 * declared-permission-broker.mjs — no createAllowAllPermissionBroker).
 */
export async function withSampleAppKernel(provider, declaredPermissions, run) {
  const kernel = createRuntimeKernel({
    permissionBroker: createDeclaredPermissionBroker(declaredPermissions),
  });
  const registration = await kernel.registerContributions(
    { providers: [provider] },
    invocationContext(),
  );
  try {
    return await run(kernel, invocationContext);
  } finally {
    registration.dispose();
  }
}
