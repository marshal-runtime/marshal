import { validateMcpUrl } from "../../common/extensions/mcp/mcp-url-validation";
import type { AddMcpServerInput, CustomMcpServer } from "../../common/marshal-ipc-contract";
import { toMcpServerKey } from "../platform/extensions/mcp-server-key";

// ── Constants ──────────────────────────────────────────────────────────────────

const RESERVED_SERVER_NAMES = new Set(
  ["filesystem", "playwright"].map((name) => toMcpServerKey(name)),
);

// ── Pure functions (exported for testability) ──────────────────────────────────

/**
 * Validate that a value is a positive safe integer (suitable for an MCP timeout in ms).
 * Returns ``{ ok: true, value: undefined }`` for ``undefined``/``null`` so callers can
 * unconditionally take ``v.value`` as ``number | undefined`` (no ``NaN`` sentinel).
 */
function validateTimeout(
  value: unknown,
): { ok: true; value: number | undefined } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, reason: "Timeout must be a number" };
  }
  if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
    return { ok: false, reason: "Timeout must be an integer" };
  }
  if (value <= 0) {
    return { ok: false, reason: "Timeout must be greater than 0" };
  }
  return { ok: true, value };
}

/**
 * Validate and build a CustomMcpServer from user input.
 * Returns the server + whether OAuth is needed, or an error string.
 */
export function validateAddMcpServer(
  input: AddMcpServerInput,
  existingServers: CustomMcpServer[],
): { server: CustomMcpServer; needsOAuth: boolean } | { error: string } {
  const name = input.name.trim();
  if (!name) return { error: "Name is required" };

  const normalizedKey = toMcpServerKey(name);
  if (RESERVED_SERVER_NAMES.has(normalizedKey)) {
    return { error: `"${name}" conflicts with a built-in server name.` };
  }

  if (existingServers.some((s) => toMcpServerKey(s.name) === normalizedKey)) {
    return { error: `A server named "${name}" already exists.` };
  }

  const timeoutValidation = validateTimeout(input.timeout);
  if (!timeoutValidation.ok) return { error: timeoutValidation.reason };
  const timeout = timeoutValidation.value;
  // Renderer's "Expose to gateway" checkbox — only carry through when the
  // user opted in (omits the field entirely otherwise so on-disk creds for
  // the unchecked case don't carry an explicit `false` that would be
  // serialised on every load).
  const exposeFlag = input.exposeAsGatewayNodeCommand
    ? { exposeAsGatewayNodeCommand: true as const }
    : {};

  if (input.mode === "command") {
    const cmd = (input.command ?? "").trim();
    if (!cmd) return { error: "Command is required" };
    // Note: naive split doesn't handle quoted paths (e.g. "C:\Program Files\node\npx" -y @foo/bar).
    // Not a practical issue — MCP commands are typically simple unquoted executables in PATH.
    const [command, ...args] = cmd.split(/\s+/);
    const envFile = input.envFile?.trim() ? { envFile: input.envFile.trim() } : {};
    return {
      server: {
        name,
        type: "command",
        command,
        args: args.length ? args : undefined,
        ...envFile,
        ...(timeout !== undefined ? { timeout } : {}),
        ...exposeFlag,
      },
      needsOAuth: false,
    };
  }

  // mode === "url"
  const url = (input.url ?? "").trim();
  const validation = validateMcpUrl(url);
  if (!validation.ok) return { error: validation.reason };

  const bearerToken = input.bearerToken?.trim();
  // Only persist ``type`` when the user selected SSE — streamable HTTP is the
  // default at every consumer (gateway-node runtime, ``buildMcpConfig``), so
  // omitting the field keeps existing on-disk records byte-identical.
  const transportField = input.transport === "sse" ? { type: "sse" as const } : {};
  const server: CustomMcpServer = bearerToken
    ? {
        name,
        url,
        accessToken: bearerToken,
        accessTokenOrigin: new URL(url).origin,
        ...transportField,
        ...(timeout !== undefined ? { timeout } : {}),
        ...exposeFlag,
      }
    : {
        name,
        url,
        ...transportField,
        ...(timeout !== undefined ? { timeout } : {}),
        ...exposeFlag,
      };

  const needsOAuth = !bearerToken && !validation.isLocalhost;
  return { server, needsOAuth };
}

/**
 * Build a CustomMcpServer from a catalog item's JSON content.
 */
export function buildCatalogMcpServer(
  name: string,
  catalogContent: string,
  existingServers: CustomMcpServer[],
): { server: CustomMcpServer } | { error: string } {
  const normalizedName = toMcpServerKey(name);
  if (existingServers.some((s) => toMcpServerKey(s.name) === normalizedName)) {
    return { error: `Server "${name}" is already installed.` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(catalogContent); // SF-4: catalog JSON from trusted first-party catalog entries; parsed to unknown and narrowed below
  } catch {
    return { error: "Invalid catalog content" };
  }

  if (parsed === null || typeof parsed !== "object") {
    return { error: "Invalid catalog content" };
  }

  const serverDef = parsed as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by typeof check above

  const command = typeof serverDef.command === "string" ? serverDef.command : "";
  const url = typeof serverDef.url === "string" ? serverDef.url : "";

  // Catalog content is first-party but defensively validate timeout the same way
  // we validate user-provided timeouts; silently drop invalid values rather than
  // failing the install. ``validateTimeout`` returns ``value: undefined`` for both
  // undefined and null, so we don't need a separate null guard here.
  const catalogTimeoutValidation = validateTimeout(serverDef.timeout);
  const timeout = catalogTimeoutValidation.ok ? catalogTimeoutValidation.value : undefined;

  // envFile is intentionally NOT carried over from catalog content. resolveMcpEnv
  // reads whatever path envFile points at and injects parsed KEY=VALUE pairs
  // into the child's env, so honoring a catalog-supplied envFile would let a
  // malicious catalog entry point at an arbitrary file (e.g. "/etc/passwd") and
  // exfiltrate parsed lines through tool responses. Catalog is first-party today,
  // but stripping here keeps it from becoming a supply-chain primitive if catalog
  // sources ever open up. Users can still attach a managed envFile after install
  // via the edit dialog, which goes through validateAddMcpServer.

  const server: CustomMcpServer =
    serverDef.type === "command"
      ? {
          name,
          type: "command",
          command,
          args: Array.isArray(serverDef.args) ? serverDef.args.map(String) : undefined,
          ...(timeout !== undefined ? { timeout } : {}),
        }
      : {
          name,
          url,
          type: serverDef.serverType === "sse" ? "sse" : "http",
          ...(timeout !== undefined ? { timeout } : {}),
        };

  return { server };
}

/**
 * Build the full args array for a catalog MCP server with user-provided config values.
 */
export function buildMcpConfigArgs(
  catalogContent: string,
  configParams: Array<{ key: string }>,
  values: Record<string, string>,
): string[] | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(catalogContent); // SF-4: catalog JSON from trusted first-party catalog entries
  } catch {
    return { error: "Invalid catalog content" };
  }

  const baseDef =
    parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by typeof check
  const baseArgs: string[] = Array.isArray(baseDef.args) ? baseDef.args.map(String) : [];

  const configArgs: string[] = [];
  for (const param of configParams) {
    const val = values[param.key]?.trim();
    if (val) configArgs.push(val);
  }

  return [...baseArgs, ...configArgs];
}
