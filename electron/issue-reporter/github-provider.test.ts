import { describe, expect, it, vi } from "vitest";

import {
  buildFallbackIssueUrl,
  createGitHubIssueReporter,
  type GhRunner,
} from "./github-provider";

function makeGh(overrides: Partial<GhRunner> = {}): GhRunner {
  return {
    isAvailable: vi.fn<GhRunner["isAvailable"]>().mockResolvedValue(true),
    canAccessRepo: vi.fn<GhRunner["canAccessRepo"]>().mockResolvedValue(true),
    createIssue: vi
      .fn<GhRunner["createIssue"]>()
      .mockResolvedValue("https://github.com/acme/widget/issues/1"),
    ...overrides,
  };
}

function makeProvider(target: string | null, gh: GhRunner = makeGh()) {
  return createGitHubIssueReporter({ getTarget: () => target, ghRunner: gh });
}

describe("createGitHubIssueReporter", () => {
  it("identifies itself as the github adapter", () => {
    const provider = makeProvider("acme/widget");
    expect(provider.id).toBe("github");
    expect(provider.displayName).toBe("GitHub");
    expect(provider.getTarget()).toBe("acme/widget");
  });

  it("is unavailable with no probe spawned when no target is configured", async () => {
    const gh = makeGh();
    const provider = makeProvider(null, gh);
    await expect(provider.checkAvailability()).resolves.toEqual({
      available: false,
      reason: "No issue destination is configured",
    });
    expect(gh.isAvailable).not.toHaveBeenCalled();
    expect(gh.canAccessRepo).not.toHaveBeenCalled();
  });

  it("is unavailable when gh is missing or unauthenticated", async () => {
    const gh = makeGh({ isAvailable: vi.fn<GhRunner["isAvailable"]>().mockResolvedValue(false) });
    await expect(makeProvider("acme/widget", gh).checkAvailability()).resolves.toEqual({
      available: false,
      reason: "gh CLI is not installed or not authenticated",
    });
    expect(gh.canAccessRepo).not.toHaveBeenCalled();
  });

  it("is unavailable when the user cannot read the target repo", async () => {
    const gh = makeGh({
      canAccessRepo: vi.fn<GhRunner["canAccessRepo"]>().mockResolvedValue(false),
    });
    await expect(makeProvider("acme/widget", gh).checkAvailability()).resolves.toEqual({
      available: false,
      reason: "No access to acme/widget",
    });
  });

  it("files the issue against the configured target", async () => {
    const gh = makeGh();
    const url = await makeProvider("acme/widget", gh).createIssue({ title: "T", body: "B" });
    expect(url).toBe("https://github.com/acme/widget/issues/1");
    expect(gh.createIssue).toHaveBeenCalledWith({
      title: "T",
      body: "B",
      repoTarget: "acme/widget",
    });
  });

  it("refuses to file when no target is configured", async () => {
    await expect(makeProvider(null).createIssue({ title: "T", body: "B" })).rejects.toThrow(
      /No issue destination is configured/,
    );
  });

  it("returns no fallback URL and no investigation profile when unconfigured", () => {
    const provider = makeProvider(null);
    expect(provider.buildFallbackUrl({ title: "T", body: "B" })).toBeNull();
    expect(provider.buildInvestigationProfile()).toBeNull();
  });

  it("builds a prefilled fallback URL scoped to the target", () => {
    const url = makeProvider("acme/widget").buildFallbackUrl({ title: "T", body: "B" });
    expect(url).toBe("https://github.com/acme/widget/issues/new?title=T&body=B");
  });

  it("scopes the investigation profile to the configured repo", () => {
    const profile = makeProvider("acme-org/widget-repo").buildInvestigationProfile();
    expect(profile).not.toBeNull();
    expect(profile!.instructions).toContain("gh search code --repo acme-org/widget-repo");
    expect(profile!.instructions).toContain("gh repo view acme-org/widget-repo");
    expect(profile!.instructions).toContain("gh api repos/acme-org/widget-repo");
    expect(profile!.instructions).toContain("`--raw-field`");
    expect(profile!.instructions).not.toContain("OmerMachluf/marshal");
    expect(profile!.permissions.allow).toContain("gh api repos/acme-org/widget-repo/*");
    expect(profile!.permissions.autoApproveReadOnly).toBe(false);
    expect(profile!.permissions.servers?.filesystem).toEqual({
      enabled: false,
      autoApprove: false,
    });
  });
});

describe("buildFallbackIssueUrl", () => {
  it("truncates oversized bodies so the URL stays usable", () => {
    const url = buildFallbackIssueUrl("t", "x".repeat(50_000), "acme/widget");
    expect(url.startsWith("https://github.com/acme/widget/issues/new?")).toBe(true);
    expect(decodeURIComponent(url)).toContain("…[truncated]…");
  });
});
