import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { RuntimeAuthLoginRequest, RuntimeAuthLoginResult } from "../runtime-contract";
import { deleteClaudeEnvironmentVariable, type ClaudeEnvironment } from "./environment";

const execFileAsync = promisify(execFile);

const AUTH_ENVIRONMENT_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
}

export interface ClaudeAuthCommandOptions {
  executablePath?: string;
  configDir: string;
  env: ClaudeEnvironment;
}

function commandEnvironment(options: ClaudeAuthCommandOptions): NodeJS.ProcessEnv {
  // ProcessEnv is globally augmented with renderer-only required keys, while child_process
  // correctly accepts a sparse environment map here.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- bridge the over-narrow global declaration without changing the subprocess environment
  return { ...options.env, CLAUDE_CONFIG_DIR: options.configDir } as unknown as NodeJS.ProcessEnv;
}

export async function getClaudeCliAuthStatus(
  options: ClaudeAuthCommandOptions & { executablePath: string },
): Promise<ClaudeAuthStatus> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(options.executablePath, ["auth", "status", "--json"], {
      env: commandEnvironment(options),
      windowsHide: true,
    }));
  } catch (error) {
    const commandOutput = error && typeof error === "object" ? Reflect.get(error, "stdout") : null;
    if (typeof commandOutput !== "string" || commandOutput.trim().length === 0) throw error;
    stdout = commandOutput;
  }
  // SF-4: parsed output comes from the bundled Claude executable and is validated below.
  const value = JSON.parse(stdout) as unknown;
  const status = value && typeof value === "object" ? value : undefined;
  const loggedIn = status ? Reflect.get(status, "loggedIn") : undefined;
  if (!status || typeof loggedIn !== "boolean") {
    throw new Error("Claude returned an invalid authentication status");
  }
  const authMethod = Reflect.get(status, "authMethod");
  return {
    loggedIn,
    ...(typeof authMethod === "string" ? { authMethod } : {}),
  };
}

function requireValue(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} must not be empty`);
  return trimmed;
}

function clearAuthenticationEnvironment(env: ClaudeEnvironment): void {
  for (const name of AUTH_ENVIRONMENT_VARIABLES) deleteClaudeEnvironmentVariable(env, name);
}

export async function loginClaude(
  env: ClaudeEnvironment,
  request: RuntimeAuthLoginRequest,
  commandOptions: ClaudeAuthCommandOptions,
): Promise<RuntimeAuthLoginResult> {
  switch (request.type) {
    case "api-key":
      clearAuthenticationEnvironment(env);
      env.ANTHROPIC_API_KEY = requireValue(request.apiKey, "Claude API key");
      return { status: "authenticated" };
    case "amazon-bedrock":
      clearAuthenticationEnvironment(env);
      env.CLAUDE_CODE_USE_BEDROCK = "1";
      env.AWS_BEARER_TOKEN_BEDROCK = requireValue(request.apiKey, "Amazon Bedrock API key");
      env.AWS_REGION = requireValue(request.region, "Amazon Bedrock region");
      return { status: "authenticated" };
    case "browser": {
      const executablePath = commandOptions.executablePath;
      if (!executablePath) {
        throw new Error(
          "Claude browser login is unavailable because its bundled executable was not found",
        );
      }
      clearAuthenticationEnvironment(env);
      await execFileAsync(executablePath, ["auth", "login", "--claudeai"], {
        env: commandEnvironment(commandOptions),
        windowsHide: true,
      });
      if (!(await getClaudeCliAuthStatus({ ...commandOptions, executablePath })).loggedIn) {
        throw new Error("Claude browser login did not complete");
      }
      return { status: "authenticated" };
    }
    case "device-code":
      throw new Error(
        "Claude device-code login is not supported. Configure an Anthropic API key or a supported cloud provider.",
      );
    case "external-token":
      throw new Error(
        "Claude external-token login is not supported. Marshal does not accept claude.ai OAuth tokens.",
      );
  }
  throw new Error("Unsupported Claude authentication request");
}

export async function logoutClaude(
  env: ClaudeEnvironment,
  commandOptions: ClaudeAuthCommandOptions,
): Promise<void> {
  clearAuthenticationEnvironment(env);
  deleteClaudeEnvironmentVariable(env, "AWS_REGION");
  if (commandOptions.executablePath) {
    await execFileAsync(commandOptions.executablePath, ["auth", "logout"], {
      env: commandEnvironment(commandOptions),
      windowsHide: true,
    });
  }
}
