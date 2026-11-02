import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

import { z } from "zod";
const run = promisify(execFile);
export async function configureTailscale(): Promise<string> {
  const candidates = [
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ];
  let binary: string | undefined;
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Prefer the first available known CLI installation.
      await access(candidate);
      binary = candidate;
      break;
    } catch {
      /* Try the next standard install location. */
    }
  }
  if (!binary)
    throw new Error(
      "Install Tailscale on this Mac from tailscale.com/download/mac, open it, and sign in. Then click Connect with Tailscale again.",
    );
  const status = await run(binary, ["status", "--json"], { timeout: 10_000, maxBuffer: 2_000_000 });
  const info = z
    .object({ BackendState: z.string(), Self: z.object({ DNSName: z.string() }).nullish() })
    .parse(JSON.parse(status.stdout) as unknown);
  if (info.BackendState !== "Running" || !info.Self?.DNSName)
    throw new Error("Open Tailscale on this Mac and sign in to the same account as your iPhone.");
  const origin = `https://${info.Self.DNSName.replace(/\.$/, "")}`;
  if (!/^https:\/\/[a-z0-9.-]+\.ts\.net$/.test(origin))
    throw new Error(
      "Tailscale did not provide a private HTTPS hostname. Enable MagicDNS in Tailscale.",
    );
  const current = await run(binary, ["serve", "status", "--json"], { timeout: 10_000 });
  const config = z.record(z.string(), z.unknown()).parse(JSON.parse(current.stdout) as unknown);
  // Do not overwrite a pre-existing Serve/Funnel configuration owned by another app.
  if (
    "AllowFunnel" in config ||
    (Object.keys(config).length && !current.stdout.includes("http://127.0.0.1:7331"))
  )
    throw new Error(
      "Tailscale already serves another app. Keep that configuration and configure a separate endpoint for Marshal manually.",
    );
  try {
    await run(binary, ["serve", "--bg", "7331"], { timeout: 20_000, maxBuffer: 100_000 });
  } catch {
    throw new Error(
      "Tailscale Serve needs HTTPS enabled. Run tailscale serve --bg 7331 in Terminal, approve the HTTPS link it displays, then try again.",
    );
  }
  return origin;
}
