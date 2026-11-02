import { describe, expect, it } from "vitest";

import type { RuntimeAuthLoginRequest } from "../runtime-contract";
import { loginClaude, logoutClaude } from "./auth";
import type { ClaudeEnvironment } from "./environment";

describe("Claude runtime authentication", () => {
  it("accepts the frozen api-key request and configures Anthropic API auth", async () => {
    const env: ClaudeEnvironment = {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_BEARER_TOKEN_BEDROCK: "old",
    };
    const request: RuntimeAuthLoginRequest = {
      type: "api-key",
      apiKey: "sk-ant-test",
    };

    await expect(loginClaude(env, request, { configDir: "/tmp/claude", env })).resolves.toEqual({
      status: "authenticated",
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
  });

  it("accepts the frozen Amazon Bedrock request using the official API-key variables", async () => {
    const env: ClaudeEnvironment = { ANTHROPIC_API_KEY: "old" };
    const request: RuntimeAuthLoginRequest = {
      type: "amazon-bedrock",
      apiKey: "bedrock-key",
      region: "us-east-1",
    };

    await expect(loginClaude(env, request, { configDir: "/tmp/claude", env })).resolves.toEqual({
      status: "authenticated",
    });
    expect(env).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-key",
      AWS_REGION: "us-east-1",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it.each([
    { type: "browser" as const, expected: /browser login is unavailable/ },
    { type: "device-code" as const, expected: /device-code login is not supported/ },
    {
      type: "external-token" as const,
      accessToken: "oauth-token",
      expected: /does not accept claude\.ai OAuth tokens/,
    },
  ])("rejects unsupported $type login", async ({ expected, ...request }) => {
    const env = {};
    await expect(loginClaude(env, request, { configDir: "/tmp/claude", env })).rejects.toThrow(
      expected,
    );
  });

  it("clears adapter-supported credentials on logout", async () => {
    const env: ClaudeEnvironment = {
      ANTHROPIC_API_KEY: "key",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock",
      AWS_REGION: "us-east-1",
      PATH: "bin",
    };

    await logoutClaude(env, { configDir: "/tmp/claude", env });

    expect(env).toEqual({ PATH: "bin" });
  });

  it("rejects empty credentials rather than reporting success", async () => {
    const env = {};
    await expect(
      loginClaude(env, { type: "api-key", apiKey: " " }, { configDir: "/tmp/claude", env }),
    ).rejects.toThrow(/must not be empty/);
    await expect(
      loginClaude(
        env,
        { type: "amazon-bedrock", apiKey: "key", region: "" },
        { configDir: "/tmp/claude", env },
      ),
    ).rejects.toThrow(/region must not be empty/);
  });
});
