import { describe, it, expect } from "vitest";

import { extractSsoUrl, isRateLimited } from "./github-api-errors";
import { testDouble } from "../testing/harness";

describe("extractSsoUrl", () => {
  it("extracts URL from X-GitHub-SSO header", () => {
    expect(extractSsoUrl("required; url=https://github.com/orgs/myorg/sso")).toBe(
      "https://github.com/orgs/myorg/sso",
    );
  });

  it("returns undefined when header has no URL", () => {
    expect(extractSsoUrl("required")).toBeUndefined();
  });

  it("returns undefined for null header", () => {
    expect(extractSsoUrl(null)).toBeUndefined();
  });
});

describe("isRateLimited", () => {
  it("returns true when X-RateLimit-Remaining is 0", () => {
    const resp = testDouble<Response>({ headers: new Headers({ "X-RateLimit-Remaining": "0" }) });
    expect(isRateLimited(resp)).toBe(true);
  });

  it("returns false when X-RateLimit-Remaining is positive", () => {
    const resp = testDouble<Response>({ headers: new Headers({ "X-RateLimit-Remaining": "42" }) });
    expect(isRateLimited(resp)).toBe(false);
  });

  it("returns false when header is absent", () => {
    const resp = testDouble<Response>({ headers: new Headers() });
    expect(isRateLimited(resp)).toBe(false);
  });
});
