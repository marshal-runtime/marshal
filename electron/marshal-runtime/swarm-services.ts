import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createRuntimeServiceToken,
  type RuntimeServiceBindingHandle,
  type RuntimeServiceContainer,
} from "@marshal/runtime";
import type { SwarmTaskRole } from "@marshal/swarm";
import type {
  SwarmRoleModelService,
  SwarmSharedContext,
  SwarmSharedContextService,
} from "@marshal/swarm";

import {
  DEFAULT_SWARM_WORKER_MODEL,
  DEFAULT_SWARM_WORKER_REASONING_EFFORT,
} from "../../common/marshal-default-settings";
import type { MSettings, ReasoningEffort } from "../../common/marshal-ipc-contract";
import type { RuntimeTranscriptPage, RuntimeTranscriptRequest } from "../session-transcript";
import { createLogger } from "../../common/marshal-logger";
import { DEFAULT_MODEL } from "../model-manager";

const log = createLogger("SwarmSharedContext");

const FIELD_GUIDE_DIRECTORY = "field-guide";
const TOPICS_DIRECTORY = "topics";
const INDEX_FILE = "index.md";
const INITIAL_FIELD_GUIDE = "# Field Guide\n";
type SwarmWorkerSettings = Pick<MSettings, "swarmWorkerModel" | "swarmWorkerReasoningEffort" | "swarmRoleModels">;

export const SWARM_EVENT_STORE_SERVICE_KEY = "@marshal/swarm:event-store";
export const SWARM_EVENT_STORE_SERVICE = Symbol.for(SWARM_EVENT_STORE_SERVICE_KEY);
/** Resolves registered transcript references through the encrypted session store. */
export const SWARM_TRANSCRIPT_READER_SERVICE = createRuntimeServiceToken<{
  read(input: RuntimeTranscriptRequest): Promise<RuntimeTranscriptPage>;
}>("@marshal/swarm:transcript-reader");
export const SWARM_SHARED_CONTEXT_SERVICE = createRuntimeServiceToken<SwarmSharedContextService>(
  "@marshal/swarm:shared-context",
);
export const SWARM_ROLE_MODEL_SERVICE = createRuntimeServiceToken<SwarmRoleModelService>(
  "@marshal/swarm:role-model",
);

/**
 * Host side of the Field Guide. `index.md` carries the run's global decisions and
 * is owned by the root planner alone; every other Markdown file under the guide
 * directory is a structured topic owned by exactly one planner, and is returned
 * as labelled sections in `content`, because the pinned Swarm archive exposes
 * only one path/content shared-context value.
 *
 * The service only ever creates directories and the initial empty `index.md`. It
 * never rewrites a file an agent owns, and it writes no status, progress, or
 * bookkeeping file: Runtime task events remain the operational source of truth.
 */
class FileSwarmSharedContextService implements SwarmSharedContextService {
  /** Runs whose topic-write precheck has already been reported, so a per-launch
   *  read does not repeat the same warning once per task prompt. */
  private readonly prechecked = new Set<string>();

  constructor(private readonly rootDirectory: string) {}

  async read(runId: string): Promise<SwarmSharedContext> {
    const directory = this.guideDirectory(runId);
    const topicsDirectory = path.join(directory, TOPICS_DIRECTORY);
    await mkdir(topicsDirectory, { recursive: true });
    const guidePath = path.join(directory, INDEX_FILE);
    await seedIndex(guidePath);
    await this.precheckTopicWrites(runId, topicsDirectory);
    const [content, topics] = await Promise.all([
      readFile(guidePath, "utf8"),
      readTopics(directory, topicsDirectory),
    ]);
    return {
      path: guidePath,
      content: [
        content,
        ...topics.map((topic) => `\n--- FIELD GUIDE TOPIC: ${topic.path} ---\n${topic.content}`),
      ].join(""),
    };
  }

  /**
   * Answers, as far as the host can, whether a planner assigned a topic file can
   * actually create it. The guide lives outside every agent worktree, so an
   * unwritable app-data directory would silently turn topic ownership into a dead
   * prompt rule. The probe name is unique, so concurrent launches cannot collide.
   *
   * This proves filesystem writability from the main process only. Marshal's
   * per-session folder-grant gate is evaluated inside the agent's own session and
   * is not knowable here, so a failure is reported, never enforced.
   */
  private async precheckTopicWrites(runId: string, topicsDirectory: string): Promise<void> {
    if (this.prechecked.has(runId)) return;
    this.prechecked.add(runId);
    const probePath = path.join(topicsDirectory, `.topic-write-probe-${randomUUID()}`);
    try {
      const handle = await open(probePath, "wx");
      await handle.close();
    } catch (error) {
      log.warn(
        "Swarm Field Guide topic directory is not writable; planner topic ownership cannot be exercised.",
        { topicsDirectory },
        error,
      );
    }
    await rm(probePath, { force: true }).catch(() => undefined);
  }

  private guideDirectory(runId: string): string {
    const runDirectory = Buffer.from(requiredText(runId, "Swarm run"), "utf8").toString(
      "base64url",
    );
    return path.join(this.rootDirectory, runDirectory, FIELD_GUIDE_DIRECTORY);
  }
}

class MarshalSwarmRoleModelService implements SwarmRoleModelService {
  constructor(
    private readonly getSettings: () => SwarmWorkerSettings,
    private readonly resolveModel: (configured?: string) => string,
  ) {}

  resolve(role: SwarmTaskRole): { model: string; reasoningEffort: string } {
    const settings = this.getSettings();
    const selection = settings.swarmRoleModels?.[role];
    if (selection) {
      return {
        model: this.resolveModel(selection.model),
        reasoningEffort: validReasoningEffort(selection.reasoningEffort) ??
          (role === "worker" ? DEFAULT_SWARM_WORKER_REASONING_EFFORT : "max"),
      };
    }
    switch (role) {
      case "worker":
        return {
          model: this.resolveModel(
            normalizedModel(settings.swarmWorkerModel) ?? DEFAULT_SWARM_WORKER_MODEL,
          ),
          reasoningEffort:
            validReasoningEffort(settings.swarmWorkerReasoningEffort) ??
            DEFAULT_SWARM_WORKER_REASONING_EFFORT,
        };
      case "planner":
      case "reconciler":
      case "reviewer":
        return { model: this.resolveModel(), reasoningEffort: "max" };
      default:
        return unsupportedSwarmRole(role);
    }
  }
}

function unsupportedSwarmRole(_role: never): never {
  throw new Error("Unsupported Swarm role.");
}

export async function bindMarshalSwarmServices(
  container: RuntimeServiceContainer,
  rootDirectory: string,
  getSettings: () => SwarmWorkerSettings = () => ({
    swarmWorkerModel: DEFAULT_SWARM_WORKER_MODEL,
    swarmWorkerReasoningEffort: DEFAULT_SWARM_WORKER_REASONING_EFFORT,
  }),
  resolveModel: (configured?: string) => string = (configured) =>
    normalizedModel(configured) ?? DEFAULT_MODEL,
): Promise<readonly RuntimeServiceBindingHandle[]> {
  return Promise.all([
    container.bind(SWARM_SHARED_CONTEXT_SERVICE, {
      useValue: new FileSwarmSharedContextService(path.resolve(rootDirectory)),
    }),
    container.bind(SWARM_ROLE_MODEL_SERVICE, {
      useValue: new MarshalSwarmRoleModelService(getSettings, resolveModel),
    }),
  ]);
}

function normalizedModel(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function validReasoningEffort(value: ReasoningEffort | undefined): ReasoningEffort | undefined {
  return value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
    ? value
    : undefined;
}

/** Creates the guide only when absent — an existing `index.md` belongs to the
 *  root planner and is never overwritten by the host. */
async function seedIndex(guidePath: string): Promise<void> {
  try {
    await writeFile(guidePath, INITIAL_FIELD_GUIDE, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
}

/**
 * Topics are discovered in the conventional `topics/` subdirectory and directly
 * beside `index.md`, because a planner is assigned an absolute path by its parent
 * and either location is a reasonable reading of that assignment. Ordering is by
 * absolute path so the injected prompt is stable across launches.
 */
async function readTopics(
  directory: string,
  topicsDirectory: string,
): Promise<readonly { path: string; content: string }[]> {
  const [beside, nested] = await Promise.all([
    markdownFiles(directory),
    markdownFiles(topicsDirectory),
  ]);
  const paths = [...beside.filter((file) => path.basename(file) !== INDEX_FILE), ...nested].sort(
    (left, right) => left.localeCompare(right),
  );
  const topics = await Promise.all(
    paths.map(async (topicPath) => {
      try {
        return { path: topicPath, content: await readFile(topicPath, "utf8") };
      } catch (error) {
        log.warn("Skipped an unreadable Field Guide topic.", { topicPath }, error);
        return undefined;
      }
    }),
  );
  return topics.filter((topic): topic is { path: string; content: string } => topic !== undefined);
}

async function markdownFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => path.join(directory, entry.name));
  } catch (error) {
    if (isMissingError(error)) return [];
    throw error;
  }
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be a non-empty string.`);
  return normalized;
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return isErrnoError(error, "EEXIST");
}

function isMissingError(error: unknown): error is NodeJS.ErrnoException {
  return isErrnoError(error, "ENOENT");
}

function isErrnoError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
