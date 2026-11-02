import { createHash } from "node:crypto";
import * as fs from "node:fs";

import { createLogger } from "../../common/marshal-logger";
import { secureAtomicWriteFileSync } from "../platform-security";
import {
  normalizeSelectedSessionOwner,
  type SelectedSessionDeliveryService,
  type SelectedSessionGrant,
  type SelectedSessionOwner,
  type SelectedSessionReceipt,
} from "./selected-session-delivery";

export interface ApplicationSessionOptions {
  /** Durable ownership record; an unreadable record blocks start and resume (fail closed). */
  readonly file: string;
  readonly delivery: Pick<SelectedSessionDeliveryService, "grant" | "revokeGrant" | "send">;
  readonly isOwnerActive: (owner: SelectedSessionOwner) => boolean | Promise<boolean>;
  /** Returns the registered workspace with exactly this name, if any. */
  readonly resolveWorkspace: (name: string) => string | undefined;
  /** Creates a normal top-level session with default permissions and returns its ID. */
  readonly createSession: (request: { name: string; workspaceName?: string }) => Promise<string>;
  /** Resolves a Marshal or backend session ID to the session's stored origin, or null. */
  readonly describeSession: (sessionId: string) => ReplyTargetFacts | null;
  readonly now?: () => number;
}

/** Stored facts that decide whether an application may reply into a session. */
export interface ReplyTargetFacts {
  readonly sessionId: string;
  readonly source?: string;
  readonly parentSessionId?: string;
  readonly permissionMode?: string;
}

export interface ApplicationSessionStart {
  readonly sessionId: string;
  readonly grantId: string;
  readonly expiresAt: string;
  readonly created: boolean;
  readonly receipt: SelectedSessionReceipt;
}

interface OwnedSession {
  readonly applicationKey: string;
  readonly requestId: string;
  readonly fingerprint: string;
  readonly sessionId: string;
  readonly createdAt: string;
}

interface LiveGrant {
  readonly sessionId: string;
  readonly grantId: string;
}

const STORE_VERSION = 1;
const MAX_ID = 256;
const MAX_TEXT = 32_768;
const MAX_NAME = 120;
const MAX_OWNED_SESSIONS = 5_000;
const MAX_LIVE_GRANTS_PER_OWNER = 16;
const USER_SCOPE_WORKSPACE = "marshal";
const USER_SOURCE = "user";
const ALLOW_ALL = "allow-all";
const REPLY_SOURCES = new Set([USER_SOURCE, "subagent"]);
const MAX_REPLY_ANCESTORS = 8;
const MISSING_FILE = "ENOENT";
const START_KEYS = ["requestId", "task", "name", "workspaceName", "context"];
const OWNED_FIELDS = ["applicationKey", "requestId", "fingerprint", "sessionId", "createdAt"];
const log = createLogger("ApplicationSessions");

/** Lets an extension application start top-level sessions and route back only to those sessions. */
export class ApplicationSessionService {
  private owned: OwnedSession[] | undefined;
  private readonly pending = new Map<
    string,
    { fingerprint: string; operation: Promise<ApplicationSessionStart> }
  >();
  private readonly liveGrants = new Map<string, LiveGrant[]>();
  private readonly now: () => number;

  constructor(private readonly options: ApplicationSessionOptions) {
    this.now = options.now ?? Date.now;
  }

  async start(ownerValue: SelectedSessionOwner, input: unknown): Promise<ApplicationSessionStart> {
    const owner = normalizeSelectedSessionOwner(ownerValue);
    const request = strictObject(input, START_KEYS);
    const requestId = text(request.requestId, "requestId", MAX_ID);
    const task = text(request.task, "task", MAX_TEXT);
    const name = request.name === undefined ? undefined : text(request.name, "name", MAX_NAME);
    const context =
      request.context === undefined ? undefined : text(request.context, "context", MAX_TEXT);
    const workspaceName = this.workspaceFor(owner, request.workspaceName);
    const fingerprint = hash([task, name, context, workspaceName]);
    const key = `${applicationKey(owner)}\0${requestId}`;
    const running = this.pending.get(key);
    if (running) {
      if (running.fingerprint !== fingerprint) throw requestConflict();
      return running.operation;
    }
    const operation = (async () => {
      await this.assertOwnerActive(owner);
      const existing = this.ownedSessions().find(
        (entry) => entry.applicationKey === applicationKey(owner) && entry.requestId === requestId,
      );
      if (existing && existing.fingerprint !== fingerprint) throw requestConflict();
      const sessionId =
        existing?.sessionId ??
        (await this.createOwned(owner, requestId, fingerprint, {
          name: name ?? task.split("\n", 1)[0].trim().slice(0, MAX_NAME),
          ...(workspaceName ? { workspaceName } : {}),
        }));
      const grant = await this.issueGrant(owner, sessionId);
      try {
        const receipt = await this.options.delivery.send(owner, {
          grantId: grant.grantId,
          requestId,
          message: task,
          ...(context !== undefined ? { context } : {}),
        });
        return { ...grantFields(grant), sessionId, created: !existing, receipt };
      } catch (error) {
        await this.revokeLive(owner, (live) => live.grantId === grant.grantId);
        throw error;
      }
    })();
    this.pending.set(key, { fingerprint, operation });
    try {
      return await operation;
    } finally {
      this.pending.delete(key);
    }
  }

  async resume(ownerValue: SelectedSessionOwner, input: unknown): Promise<SelectedSessionGrant> {
    const owner = normalizeSelectedSessionOwner(ownerValue);
    const sessionId = text(strictObject(input, ["sessionId"]).sessionId, "sessionId", MAX_ID);
    await this.assertOwnerActive(owner);
    if (
      !this.ownedSessions().some(
        (entry) => entry.applicationKey === applicationKey(owner) && entry.sessionId === sessionId,
      )
    )
      throw failure("permission_denied", "This application did not start that session.");
    return grantFields(await this.issueGrant(owner, sessionId));
  }

  /** Grants delivery into a session of the user's own tree; no session in the chain may skip approvals. */
  async reply(ownerValue: SelectedSessionOwner, input: unknown): Promise<SelectedSessionGrant> {
    const owner = normalizeSelectedSessionOwner(ownerValue);
    const sessionId = text(strictObject(input, ["sessionId"]).sessionId, "sessionId", MAX_ID);
    await this.assertOwnerActive(owner);
    const facts = this.options.describeSession(sessionId);
    if (!facts) throw failure("permission_denied", "That session does not exist.");
    this.assertUserTree(facts);
    return grantFields(await this.issueGrant(owner, facts.sessionId));
  }

  private assertUserTree(target: ReplyTargetFacts): void {
    const chain = [target];
    while (chain.length <= MAX_REPLY_ANCESTORS && chain[chain.length - 1].parentSessionId) {
      const parent = this.options.describeSession(chain[chain.length - 1].parentSessionId!);
      if (!parent) throw failure("permission_denied", "The session's parent does not exist.");
      chain.push(parent);
    }
    const root = chain[chain.length - 1];
    if (root.parentSessionId || (root.source ?? USER_SOURCE) !== USER_SOURCE)
      throw failure(
        "permission_denied",
        "Replies go only to sessions that the user started or delegated.",
      );
    if (chain.some((session) => !REPLY_SOURCES.has(session.source ?? USER_SOURCE)))
      throw failure("permission_denied", "Replies never go to automation sessions.");
    if (chain.some((session) => session.permissionMode === ALLOW_ALL))
      throw failure("permission_denied", "Replies never go to a session that skips approvals.");
  }

  private workspaceFor(owner: SelectedSessionOwner, requested: unknown): string | undefined {
    const name =
      requested === undefined ? undefined : text(requested, "workspaceName", MAX_ID).trim();
    if (owner.applicationScope === "user") {
      if (!name) return undefined;
      const resolved = this.options.resolveWorkspace(name);
      if (!resolved) throw failure("invalid_input", `Workspace not found: ${name}`);
      return resolved;
    }
    if (name && name !== owner.workspaceName)
      throw failure("permission_denied", "Sessions must start in this application's workspace.");
    if (owner.workspaceName === USER_SCOPE_WORKSPACE) return undefined;
    const resolved = this.options.resolveWorkspace(owner.workspaceName);
    if (!resolved)
      throw failure("permission_denied", "This application's workspace is unavailable.");
    return resolved;
  }

  /** Keeps at most one live grant per owned session and a small cap per owner. */
  private async issueGrant(
    owner: SelectedSessionOwner,
    sessionId: string,
  ): Promise<SelectedSessionGrant> {
    await this.revokeLive(owner, (live) => live.sessionId === sessionId);
    const lives = this.liveGrants.get(grantOwnerKey(owner)) ?? [];
    if (lives.length >= MAX_LIVE_GRANTS_PER_OWNER) {
      const oldest = lives[0];
      await this.revokeLive(owner, (live) => live === oldest);
    }
    const grant = await this.options.delivery.grant(owner, sessionId);
    this.liveGrants.set(grantOwnerKey(owner), [
      ...(this.liveGrants.get(grantOwnerKey(owner)) ?? []),
      { sessionId, grantId: grant.grantId },
    ]);
    return grant;
  }

  private async revokeLive(
    owner: SelectedSessionOwner,
    matches: (live: LiveGrant) => boolean,
  ): Promise<void> {
    const lives = this.liveGrants.get(grantOwnerKey(owner)) ?? [];
    await Promise.all(
      lives
        .filter(matches)
        .map((live) =>
          this.options.delivery.revokeGrant(owner, live.grantId).catch(() => undefined),
        ),
    );
    this.liveGrants.set(
      grantOwnerKey(owner),
      lives.filter((live) => !matches(live)),
    );
  }

  private async createOwned(
    owner: SelectedSessionOwner,
    requestId: string,
    fingerprint: string,
    request: { name: string; workspaceName?: string },
  ): Promise<string> {
    this.ownedSessions();
    const sessionId = await this.options.createSession(request);
    const next = [
      ...this.ownedSessions(),
      {
        applicationKey: applicationKey(owner),
        requestId,
        fingerprint,
        sessionId,
        createdAt: new Date(this.now()).toISOString(),
      },
    ].slice(-MAX_OWNED_SESSIONS);
    secureAtomicWriteFileSync(
      this.options.file,
      JSON.stringify({ version: STORE_VERSION, sessions: next }, null, 2),
    );
    this.owned = next;
    return sessionId;
  }

  private ownedSessions(): OwnedSession[] {
    this.owned ??= readOwned(this.options.file);
    return this.owned;
  }

  private async assertOwnerActive(owner: SelectedSessionOwner): Promise<void> {
    if (!(await this.options.isOwnerActive(owner)))
      throw failure("permission_denied", "The extension application is no longer active.");
  }
}

/** Throws rather than returning an empty list so a damaged record is never overwritten. */
function readOwned(file: string): OwnedSession[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (Reflect.get(Object(error), "code") === MISSING_FILE) return [];
    throw unreadable(error);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const sessions =
      parsed && typeof parsed === "object" ? Reflect.get(parsed, "sessions") : undefined;
    if (!Array.isArray(sessions)) throw new Error("missing sessions list");
    return sessions.filter(isOwnedSession);
  } catch (error) {
    throw unreadable(error);
  }
}

function unreadable(error: unknown): Error {
  log.warn("Application session ownership record is unreadable", {
    error: error instanceof Error ? error.message : String(error),
  });
  return failure(
    "permission_denied",
    "The application session ownership record is unreadable; repair or remove it to continue.",
  );
}

function isOwnedSession(value: unknown): value is OwnedSession {
  return (
    !!value &&
    typeof value === "object" &&
    OWNED_FIELDS.every((field) => typeof Reflect.get(value, field) === "string")
  );
}

function applicationKey(owner: SelectedSessionOwner): string {
  const scope = owner.applicationScope ?? "session";
  return [
    owner.extensionId,
    owner.applicationId,
    scope,
    scope === "user" ? "" : owner.workspaceName,
    owner.sessionId ?? "",
  ].join("\0");
}

function grantOwnerKey(owner: SelectedSessionOwner): string {
  return JSON.stringify(owner);
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function grantFields(grant: SelectedSessionGrant): SelectedSessionGrant {
  return {
    grantId: grant.grantId,
    targetSessionId: grant.targetSessionId,
    expiresAt: grant.expiresAt,
  };
}

function strictObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw failure("invalid_input", "Input must be an object.");
  const request = Object.fromEntries(Object.entries(value));
  if (Object.keys(request).some((key) => !allowed.includes(key)))
    throw failure("invalid_input", "Unexpected input property.");
  return request;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw failure("invalid_input", `${field} must contain 1 to ${max} characters.`);
  return value;
}

function requestConflict(): Error {
  return failure("conflict", "This request ID was already used with different content.");
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
