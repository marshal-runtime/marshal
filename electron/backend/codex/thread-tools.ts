import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { createLogger } from "../../../common/marshal-logger";
import type { CodexDynamicToolSpec } from "./config";

const log = createLogger("CodexThreadTools");

const STORE_FILENAME = "marshal-thread-tools.json";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Identity of the tool set a thread was started with: names, namespaces,
 * deferral and input schemas, order-independent. Descriptions are excluded so prose tweaks that do not
 * change the call contract never force a thread replacement.
 */
interface ToolIdentity {
  namespace: string | null;
  name: string;
  deferred: boolean;
  inputSchema: unknown;
}

function toolIdentities(specs: readonly CodexDynamicToolSpec[]): ToolIdentity[] {
  const identities: ToolIdentity[] = [];
  for (const spec of specs) {
    const functions = spec.type === "namespace" ? spec.tools : [spec];
    for (const tool of functions) {
      identities.push({
        namespace: spec.type === "namespace" ? spec.name : null,
        name: tool.name,
        deferred: tool.deferLoading === true,
        inputSchema: tool.inputSchema,
      });
    }
  }
  return identities;
}

export function hashDynamicTools(specs: readonly CodexDynamicToolSpec[]): string {
  const key = (identity: ToolIdentity) => `${identity.namespace ?? ""}/${identity.name}`;
  const entries = toolIdentities(specs).toSorted((left, right) =>
    key(left) < key(right) ? -1 : 1,
  );
  return createHash("sha256").update(canonicalJson(entries)).digest("hex");
}

/**
 * `thread/resume` cannot re-advertise `dynamicTools`, so the tool set a thread
 * was started with is frozen. This records that identity per thread, next to
 * the rollouts in the Marshal-owned CODEX_HOME (so it is account-scoped and
 * disappears with them), letting resume notice drift.
 */
export class CodexThreadToolStore {
  private readonly file: string | undefined;
  private cache: Map<string, string> | undefined;
  private writes: Promise<void> = Promise.resolve();

  /** Without a CODEX_HOME the store is memory-only (drift is then only detected within one app run). */
  constructor(codexHome?: string) {
    this.file = codexHome ? path.join(codexHome, STORE_FILENAME) : undefined;
  }

  async get(threadId: string): Promise<string | undefined> {
    return (await this.load()).get(threadId);
  }

  async set(threadId: string, hash: string): Promise<void> {
    const entries = await this.load();
    if (entries.get(threadId) === hash) return;
    entries.set(threadId, hash);
    await this.persist(entries);
  }

  async delete(threadId: string): Promise<void> {
    const entries = await this.load();
    if (!entries.delete(threadId)) return;
    await this.persist(entries);
  }

  private async load(): Promise<Map<string, string>> {
    if (this.cache) return this.cache;
    const entries = new Map<string, string>();
    if (!this.file) {
      this.cache = entries;
      return entries;
    }
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        for (const [threadId, hash] of Object.entries(parsed)) {
          if (typeof hash === "string") entries.set(threadId, hash);
        }
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        log.warn("Ignoring unreadable thread tool store:", error);
      }
    }
    this.cache = entries;
    return entries;
  }

  private persist(entries: Map<string, string>): Promise<void> {
    const file = this.file;
    if (!file) return Promise.resolve();
    const snapshot = JSON.stringify(Object.fromEntries(entries));
    const write = this.writes.then(async () => {
      try {
        await mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.tmp`;
        await writeFile(temporary, snapshot, "utf8");
        await rename(temporary, file);
      } catch (error) {
        log.warn("Failed to persist thread tool store:", error);
      }
    });
    this.writes = write;
    return write;
  }
}
