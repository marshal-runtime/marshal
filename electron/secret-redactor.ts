export const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // GitHub fine-grained PAT must come before generic ghp_ family
  { name: "github-fine-grained", pattern: /github_pat_[A-Za-z0-9_]{22}_[A-Za-z0-9_]{59}/g },
  { name: "github-pat", pattern: /ghp_[A-Za-z0-9_]{36,}/g },
  { name: "github-oauth", pattern: /ghu_[A-Za-z0-9_]{36,}/g },
  { name: "github-actions", pattern: /ghs_[A-Za-z0-9_]{36,}/g },
  { name: "github-refresh", pattern: /ghr_[A-Za-z0-9_]{36,}/g },
  // JWTs: header and payload both decode to `{…` so both start with eyJ
  { name: "jwt", pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: "aws-access-key", pattern: /(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}/g },
  { name: "slack-token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  // Anthropic must come before the generic sk- pattern
  { name: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{90,}/g },
  { name: "openai-key", pattern: /sk-[A-Za-z0-9_-]{40,}/g },
  { name: "google-api-key", pattern: /AIza[A-Za-z0-9_-]{35}/g },
  { name: "azure-sas-sig", pattern: /(?<=sig=)[A-Za-z0-9%+/]{40,}/g },
  { name: "npm-token", pattern: /npm_[A-Za-z0-9]{36}/g },
];

export function redactSecrets(text: string): { result: string; count: number } {
  let result = text;
  let count = 0;

  for (const { name, pattern } of SECRET_PATTERNS) {
    result = result.replace(pattern, () => {
      count++;
      return `[REDACTED:${name}]`;
    });
  }

  return { result, count };
}
