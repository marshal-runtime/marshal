// Marshal-owned Electron network fetch boundary.

/**
 * Shared net.fetch wrapper.
 * Uses Electron's net.fetch which goes through the Electron network stack
 * (handles proxies, the system SSL cert store, setCertificateVerifyProc, etc.).
 * Falls back to globalThis.fetch in test environments where electron is unavailable.
 *
 * Uses createRequire() instead of bare require() because Vite bundles the main
 * process as ESM where require() is undefined. createRequire() builds a real
 * require function from the module system.
 */
import { createRequire } from "node:module";

let _fetchImpl: typeof globalThis.fetch;
try {
  const esmRequire = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dynamic CJS require boundary
  const { net } = esmRequire("electron") as typeof import("electron");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Electron net.fetch is API-compatible with globalThis.fetch
  _fetchImpl = net.fetch.bind(net) as unknown as typeof globalThis.fetch;
} catch {
  _fetchImpl = globalThis.fetch;
}

export function getNetFetch(): typeof globalThis.fetch {
  return _fetchImpl;
}
