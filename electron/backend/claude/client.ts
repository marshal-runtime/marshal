import { randomUUID } from "node:crypto";

import type { ModelInfo, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { unavailableUsage, type RuntimeAccountUsage } from "../../../common/runtime-account-usage";
import { CLAUDE_AUTH_SETUP_INSTRUCTIONS } from "../../../common/runtime-config";
import type {
  RuntimeAuthLoginRequest,
  RuntimeAuthLoginResult,
  RuntimeClient,
  RuntimeModelInfo,
  RuntimeProcessHandle,
  RuntimeSessionConfig,
} from "../runtime-contract";
import { AsyncInputQueue } from "./async-input";
import { getClaudeCliAuthStatus, loginClaude, logoutClaude } from "./auth";
import type { ClaudeClientConfiguration } from "./config";
import { toClaudeQueryOptions } from "./config";
import { readClaudeConversationState } from "./conversation-state";
import { isTruthyEnvironmentFlag, readClaudeEnvironmentVariable } from "./environment";
import type { ClaudeProcessRegistry } from "./process-registry";
import type { ClaudeSdkFacade } from "./sdk-facade";
import { ClaudeRuntimeSession } from "./session";
import { ClaudeToolInvocationRegistry } from "./tool-invocations";
import {
  claudeRateLimitEvents,
  claudeUsageFromResponse,
  isClaudeAuthFailure,
  type ClaudeUsageResponse,
} from "./usage";

const USAGE_READ_TIMEOUT_MS = 30_000;

/**
 * `Query.supportedModels()` called with no `options.model` only returns the
 * host's default alias shortlist (currently default/opus/fable/sonnet/haiku)
 * — it is not an exhaustive model catalog. Every other concrete model is
 * still known to the SDK, but its capability metadata only comes back when
 * that exact id is passed as `options.model` on the probing query.
 * https://github.com/anthropics/claude-agent-sdk-typescript/issues/417
 */
export const ADDITIONAL_PROBE_MODEL_IDS = [
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
] as const;

function mapModel(model: ModelInfo): RuntimeModelInfo {
  return {
    id: model.value,
    name: model.displayName,
    supportedReasoningEfforts: model.supportedEffortLevels,
    defaultReasoningEffort: model.supportsEffort ? "high" : undefined,
    supportedContextTiers: ["default"],
    capabilities: {
      supports: {
        reasoningEffort: model.supportsEffort,
      },
    },
    billing: {
      description: model.description,
      resolvedModel: model.resolvedModel,
      supportsAdaptiveThinking: model.supportsAdaptiveThinking,
      supportsFastMode: model.supportsFastMode,
    },
  };
}

const MODEL_ID_VERSION = /^claude-[a-z0-9-]+?-(\d+)(?:-(\d+))?(?:-\d{8})?$/;

/** "Fable" + claude-fable-5-1 → "Fable 5.1"; undefined when the id encodes
 *  no version. Display names that already carry a digit pass through. */
function versionSuffixedName(displayName: string, id: string): string | undefined {
  if (/\d/.test(displayName)) return displayName;
  const version = MODEL_ID_VERSION.exec(id);
  if (!version) return undefined;
  return `${displayName} ${version[1]}${version[2] ? `.${version[2]}` : ""}`;
}

function pinnedModelName(model: ModelInfo): string {
  const resolved = model.resolvedModel;
  if (!resolved) return model.displayName;
  return versionSuffixedName(model.displayName, resolved) ?? resolved;
}

export function expandClaudeModels(models: ModelInfo[]): RuntimeModelInfo[] {
  const mapped = models.map(mapModel);
  const listedIds = new Set(mapped.map((model) => model.id));
  const pinned: RuntimeModelInfo[] = [];
  for (const [index, model] of models.entries()) {
    const entry = mapped[index];
    if (!entry) continue;
    if (!model.resolvedModel || model.resolvedModel === model.value) {
      // Probed concrete ids (ADDITIONAL_PROBE_MODEL_IDS) can report an
      // unversioned display name — claude-fable-5-1 comes back as "Fable" —
      // indistinguishable from the alias entry in the model picker.
      const versioned = versionSuffixedName(model.displayName, model.value);
      if (versioned && versioned !== entry.name) mapped[index] = { ...entry, name: versioned };
      continue;
    }
    mapped[index] = { ...entry, name: `${model.displayName} (Latest)` };
    // The alias keeps its "(Latest)" label even when its resolved target is
    // already listed (e.g. via probe) — only the pinned duplicate is skipped.
    if (listedIds.has(model.resolvedModel)) continue;
    pinned.push({
      ...entry,
      id: model.resolvedModel,
      name: pinnedModelName(model),
      billing: { ...entry.billing, pinned: true, alias: model.value },
    });
    listedIds.add(model.resolvedModel);
  }
  return [...mapped, ...pinned];
}

const PROVIDER_ENVIRONMENT_FLAGS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

export class ClaudeRuntimeClient implements RuntimeClient {
  private readonly sessions = new Map<string, ClaudeRuntimeSession>();
  private cachedModels: RuntimeModelInfo[] | undefined;
  private forceStopping = false;
  private forceStopErrors: Error[] = [];

  constructor(
    private readonly sdk: ClaudeSdkFacade,
    private readonly configuration: ClaudeClientConfiguration,
    private readonly processes: ClaudeProcessRegistry,
  ) {}

  get process(): RuntimeProcessHandle | undefined {
    return this.processes.first();
  }

  markForceStopping(): void {
    this.forceStopping = true;
    this.forceStopErrors.push(...this.processes.forceKillAll());
  }

  async stop(): Promise<Error[]> {
    const errors = this.forceStopErrors.splice(0);
    const sessions = [...this.sessions.values()];
    const results = await Promise.allSettled(sessions.map((session) => session.disconnect()));
    for (const result of results) {
      if (result.status === "rejected") {
        errors.push(
          result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
        );
      }
    }
    if (!this.forceStopping) {
      errors.push(...this.processes.killAll("SIGTERM"));
    }
    this.sessions.clear();
    return errors;
  }

  async deleteSession(id: string): Promise<void> {
    const activeSession = this.sessions.get(id);
    const sessionDirectory = activeSession?.workingDirectory;
    await activeSession?.disconnect();
    if (sessionDirectory) {
      await this.sdk.deleteSession(id, { dir: sessionDirectory });
      return;
    }
    await this.sdk.deleteSession(id);
  }

  async getAuthStatus(): Promise<{
    isAuthenticated: boolean;
    login?: string;
    statusMessage?: string;
  }> {
    const env = this.configuration.env;
    if (
      readClaudeEnvironmentVariable(env, "ANTHROPIC_API_KEY") ||
      readClaudeEnvironmentVariable(env, "ANTHROPIC_AUTH_TOKEN")
    ) {
      return {
        isAuthenticated: true,
        login: "api-key",
        statusMessage: "Claude Agent API credentials are configured",
      };
    }

    const provider = [
      ["amazon-bedrock", "CLAUDE_CODE_USE_BEDROCK"],
      ["claude-platform-aws", "CLAUDE_CODE_USE_ANTHROPIC_AWS"],
      ["google-vertex", "CLAUDE_CODE_USE_VERTEX"],
    ].find(([, variable]) => isTruthyEnvironmentFlag(readClaudeEnvironmentVariable(env, variable)));
    if (provider) {
      return {
        isAuthenticated: true,
        login: provider[0],
        statusMessage: `Claude Agent is configured for ${provider[0]} credentials`,
      };
    }
    if (this.configuration.authExecutablePath) {
      const cliStatus = await getClaudeCliAuthStatus({
        executablePath: this.configuration.authExecutablePath,
        configDir: this.configuration.configDir ?? "",
        env,
      });
      if (cliStatus.loggedIn) {
        return {
          isAuthenticated: true,
          login: cliStatus.authMethod ?? "oauth",
          statusMessage: "Claude Agent is signed in with your Claude account",
        };
      }
    }
    return {
      isAuthenticated: false,
      statusMessage: CLAUDE_AUTH_SETUP_INSTRUCTIONS,
    };
  }

  async login(request: RuntimeAuthLoginRequest): Promise<RuntimeAuthLoginResult> {
    if (this.sessions.size > 0) {
      throw new Error("Cannot change Claude authentication while sessions are active");
    }
    if (request.type === "browser" && !this.configuration.authExecutablePath) {
      throw new Error(
        "Claude browser login is unavailable because its bundled executable was not found",
      );
    }
    const result = await loginClaude(this.configuration.env, request, {
      executablePath: this.configuration.authExecutablePath,
      configDir: this.configuration.configDir ?? "",
      env: this.configuration.env,
    });
    this.cachedModels = undefined;
    return result;
  }

  async logout(): Promise<void> {
    const errors = await this.stop();
    await logoutClaude(this.configuration.env, {
      executablePath: this.configuration.authExecutablePath,
      configDir: this.configuration.configDir ?? "",
      env: this.configuration.env,
    });
    this.cachedModels = undefined;
    if (errors.length > 0) {
      throw new AggregateError(errors, "Claude logout could not stop every active process");
    }
  }

  async listModels(): Promise<RuntimeModelInfo[]> {
    if (this.cachedModels) return this.cachedModels;
    const [baseModels, ...probes] = await Promise.all([
      this.querySupportedModels(),
      ...ADDITIONAL_PROBE_MODEL_IDS.map((model) =>
        this.querySupportedModels(model).catch(() => [] as ModelInfo[]),
      ),
    ]);
    const known = new Set(baseModels.map((model) => model.resolvedModel ?? model.value));
    const extra: ModelInfo[] = [];
    for (const [index, id] of ADDITIONAL_PROBE_MODEL_IDS.entries()) {
      const match = probes[index]?.find((model) => model.value === id);
      const key = match && (match.resolvedModel ?? match.value);
      if (match && key && !known.has(key)) {
        known.add(key);
        extra.push(match);
      }
    }
    this.cachedModels = expandClaudeModels([...baseModels, ...extra]);
    return this.cachedModels;
  }

  private async querySupportedModels(model?: string): Promise<ModelInfo[]> {
    return this.withProbeQuery((query) => query.supportedModels(), model);
  }

  /**
   * Plan usage for this client's account. The read is one control request on a short-lived
   * query that never receives a prompt, so it costs no model turn and needs no live session;
   * the CLI refreshes an expiring OAuth token itself while serving it.
   */
  async getUsage(): Promise<RuntimeAccountUsage> {
    const env = this.configuration.env;
    if (
      readClaudeEnvironmentVariable(env, "ANTHROPIC_API_KEY") ||
      readClaudeEnvironmentVariable(env, "ANTHROPIC_AUTH_TOKEN") ||
      PROVIDER_ENVIRONMENT_FLAGS.some((name) =>
        isTruthyEnvironmentFlag(readClaudeEnvironmentVariable(env, name)),
      )
    ) {
      return unavailableUsage("not_applicable", "Plan usage is only reported for Claude sign-ins");
    }
    let response: ClaudeUsageResponse;
    try {
      response = await this.withProbeQuery(async (query) => {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Claude usage read timed out")),
            USAGE_READ_TIMEOUT_MS,
          );
        });
        try {
          return await Promise.race([
            query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
              skipBehaviors: true,
            }),
            timeout,
          ]);
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (error) {
      if (isClaudeAuthFailure(error)) {
        return unavailableUsage("auth_expired", "Sign in again to restore plan usage");
      }
      return this.cachedUsageOr(unavailableUsage("error", "Plan usage could not be loaded"));
    }
    if (response.rate_limits_available === false) return this.unusableLoginUsage();
    const usage = claudeUsageFromResponse(response);
    if (usage) return usage;
    return this.cachedUsageOr(
      unavailableUsage("error", "Plan usage could not be loaded"),
      response.subscription_type,
    );
  }

  private cachedUsageOr(fallback: RuntimeAccountUsage, plan?: string | null): RuntimeAccountUsage {
    const windows = claudeRateLimitEvents.read(this.configuration.configDir ?? "");
    if (windows.length === 0) return fallback;
    return {
      available: true,
      ...(plan ? { plan: plan.toLowerCase() } : {}),
      windows,
      fetchedAt: Date.now(),
    };
  }

  /** The CLI reports no plan limits for an account it cannot use as a subscription login. */
  private async unusableLoginUsage(): Promise<RuntimeAccountUsage> {
    const executablePath = this.configuration.authExecutablePath;
    if (!executablePath) return unavailableUsage("error", "Plan usage could not be loaded");
    try {
      const status = await getClaudeCliAuthStatus({
        executablePath,
        configDir: this.configuration.configDir ?? "",
        env: this.configuration.env,
      });
      if (!status.loggedIn) return unavailableUsage("signed_out");
      if (status.authMethod && status.authMethod !== "claude.ai") {
        return unavailableUsage(
          "not_applicable",
          "Plan usage is only reported for Claude sign-ins",
        );
      }
      return unavailableUsage("auth_expired", "Sign in again to restore plan usage");
    } catch {
      return unavailableUsage("error", "Plan usage could not be loaded");
    }
  }

  private async withProbeQuery<T>(run: (query: Query) => Promise<T>, model?: string): Promise<T> {
    const input = new AsyncInputQueue<SDKUserMessage>();
    const invocations = new ClaudeToolInvocationRegistry();
    let query: Query | undefined;
    try {
      const options = toClaudeQueryOptions({
        client: this.configuration,
        config: {
          cwd: this.configuration.workspaceDir,
          streaming: false,
          onPermissionRequest: () => ({ kind: "user-not-available" }),
          ...(model ? { model } : {}),
        },
        sessionId: randomUUID(),
        resume: false,
        toolAliases: {},
        invocations,
      });
      options.persistSession = false;
      options.tools = [];
      query = this.sdk.query({ prompt: input, options });
      return await run(query);
    } finally {
      input.close();
      query?.close();
    }
  }

  async createSession(config: RuntimeSessionConfig): Promise<ClaudeRuntimeSession> {
    return this.create(config, randomUUID(), false);
  }

  async resumeSession(id: string, config: RuntimeSessionConfig): Promise<ClaudeRuntimeSession> {
    return this.create(config, id, true);
  }

  async readConversationState(id: string, workingDirectory: string) {
    return readClaudeConversationState(this.sdk, id, workingDirectory);
  }

  private async create(
    config: RuntimeSessionConfig,
    id: string,
    resume: boolean,
  ): Promise<ClaudeRuntimeSession> {
    if (this.sessions.has(id)) {
      throw new Error(`Claude session ${id} is already active`);
    }
    const session = new ClaudeRuntimeSession(
      this.sdk,
      this.configuration,
      config,
      id,
      resume,
      (closedId) => this.sessions.delete(closedId),
      (closedId) => this.processes.forceKillSession(closedId),
    );
    this.sessions.set(id, session);
    try {
      await session.initialize();
      return session;
    } catch (error) {
      await session.destroy();
      throw error;
    }
  }
}
