// Marshal-owned test
import { describe, expect, it } from "vitest";

import { redactSecrets } from "./secret-redactor";

describe("redactSecrets", () => {
  it("leaves text with no secrets unchanged", () => {
    const { result, count } = redactSecrets("Hello, world! No secrets here.");
    expect(result).toBe("Hello, world! No secrets here.");
    expect(count).toBe(0);
  });

  it("redacts GitHub classic PAT (ghp_)", () => {
    const text = "Token: ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    expect(redactSecrets(text).result).toBe("Token: [REDACTED:github-pat]");
  });

  it("redacts GitHub OAuth token (ghu_)", () => {
    const text = "Auth: ghu_abcdefghijklmnopqrstuvwxyz0123456789";
    expect(redactSecrets(text).result).toBe("Auth: [REDACTED:github-oauth]");
  });

  it("redacts GitHub Actions token (ghs_)", () => {
    const text = "ghs_abcdefghijklmnopqrstuvwxyz0123456789";
    expect(redactSecrets(text).result).toBe("[REDACTED:github-actions]");
  });

  it("redacts GitHub refresh token (ghr_)", () => {
    const text = "ghr_abcdefghijklmnopqrstuvwxyz0123456789";
    expect(redactSecrets(text).result).toBe("[REDACTED:github-refresh]");
  });

  it("redacts GitHub fine-grained PAT", () => {
    const token = "github_pat_" + "a".repeat(22) + "_" + "b".repeat(59);
    expect(redactSecrets(`Found: ${token}`).result).toBe("Found: [REDACTED:github-fine-grained]");
  });

  it("redacts JWT bearer tokens", () => {
    const jwt =
      "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redactSecrets(`Bearer ${jwt}`).result).toBe("Bearer [REDACTED:jwt]");
  });

  it("redacts AWS access key", () => {
    expect(redactSecrets("Key: AKIAIOSFODNN7EXAMPLE").result).toBe(
      "Key: [REDACTED:aws-access-key]",
    );
  });

  it("redacts Slack bot token", () => {
    expect(redactSecrets("xoxb-123456789012-1234567890ab").result).toBe("[REDACTED:slack-token]");
  });

  it("redacts Anthropic API key (more specific than generic sk- pattern)", () => {
    const key = "sk-ant-api03-" + "A".repeat(90);
    expect(redactSecrets(key).result).toBe("[REDACTED:anthropic-key]");
  });

  it("redacts OpenAI API key (sk-)", () => {
    const key = "sk-" + "A".repeat(40);
    expect(redactSecrets(`Key: ${key}`).result).toBe("Key: [REDACTED:openai-key]");
  });

  it("redacts Google API key (AIza)", () => {
    const key = "AIza" + "A".repeat(35);
    expect(redactSecrets(`key=${key}`).result).toBe("key=[REDACTED:google-api-key]");
  });

  it("redacts Azure SAS signature parameter", () => {
    const text = "https://blob.core.windows.net/f?sv=2021&sig=" + "A".repeat(40);
    expect(redactSecrets(text).result).toBe(
      "https://blob.core.windows.net/f?sv=2021&sig=[REDACTED:azure-sas-sig]",
    );
  });

  it("redacts npm token", () => {
    const token = "npm_" + "A".repeat(36);
    expect(redactSecrets(token).result).toBe("[REDACTED:npm-token]");
  });

  it("redacts multiple different patterns in one string", () => {
    const text = `PAT ghp_abcdefghijklmnopqrstuvwxyz0123456789 and key AKIAIOSFODNN7EXAMPLE`;
    const { result } = redactSecrets(text);
    expect(result).toContain("[REDACTED:github-pat]");
    expect(result).toContain("[REDACTED:aws-access-key]");
    expect(result).not.toContain("ghp_");
    expect(result).not.toContain("AKIA");
  });

  it("redacts multiple occurrences of the same pattern", () => {
    const pat = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const text = `First: ${pat} Second: ${pat}`;
    const { result } = redactSecrets(text);
    expect(result).toBe("First: [REDACTED:github-pat] Second: [REDACTED:github-pat]");
  });

  it("uses [REDACTED:name] format exactly", () => {
    const { result } = redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(result).toMatch(/^\[REDACTED:[a-z-]+\]$/);
  });

  it("an sk-ant- key shorter than the anthropic threshold falls through to openai-key", () => {
    // sk-ant- plus 45 chars is 52 total — below anthropic's {90,} minimum
    const key = "sk-ant-" + "A".repeat(45);
    expect(redactSecrets(key).result).toBe("[REDACTED:openai-key]");
  });

  it("returns count of total redactions made", () => {
    const pat = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    expect(redactSecrets(`${pat} and ${pat}`).count).toBe(2);
    expect(redactSecrets("no secrets here").count).toBe(0);
  });
});
