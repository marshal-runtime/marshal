// Marshal-owned test
/**
 * Integration tests for GitHub bundle import flows.
 * Tests previewGithubBundle and importGithubBundle with mocked fetch + fs.
 */
import * as path from "path";

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks (must be declared before importing the module under test) ---

// vi.hoisted runs BEFORE imports, so globalThis.fetch is set before
// github-bundle.ts captures it in `const fetchImpl = getNetFetch()`.
const mockFetch = vi.hoisted(() => {
  const fn = vi.fn<(...args: unknown[]) => unknown>();
  globalThis.fetch = fn as unknown as typeof globalThis.fetch; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- mock fetch
  return fn;
});

// Mock electron so github-bundle.ts falls back to globalThis.fetch
vi.mock("electron", () => {
  throw new Error("not available");
});

// Track filesystem operations
const mockDirs = new Set<string>();
const mockFileContents = new Map<string, string | Buffer>();

vi.mock("fs", () => ({
  existsSync: (p: string) => mockDirs.has(p) || mockFileContents.has(p),
  mkdirSync: (p: string) => {
    mockDirs.add(p);
  },
  mkdtempSync: (prefix: string) => {
    const tmp = prefix + "test123";
    mockDirs.add(tmp);
    return tmp;
  },
  writeFileSync: (p: string, content: string | Buffer) => {
    mockFileContents.set(p, content);
  },
  rmSync: (p: string) => {
    mockDirs.delete(p);
    for (const key of mockFileContents.keys()) {
      if (key.startsWith(p)) mockFileContents.delete(key);
    }
  },
  renameSync: (src: string, dest: string) => {
    // Move all files from src prefix to dest prefix
    for (const [key, val] of [...mockFileContents.entries()]) {
      if (key.startsWith(src)) {
        mockFileContents.set(key.replace(src, dest), val);
        mockFileContents.delete(key);
      }
    }
    mockDirs.delete(src);
    mockDirs.add(dest);
  },
  readFileSync: (p: string) => {
    if (mockFileContents.has(p)) return mockFileContents.get(p);
    throw new Error(`ENOENT: ${p}`);
  },
}));

// Mock platform-security module
vi.mock("./platform-security", () => ({
  stripSymlinks: () => {},
}));

// Mock skills module to avoid real filesystem
const registeredSkills: Array<{
  name: string;
  desc: string;
  instructions: string;
  bundleDirs?: string[];
}> = [];
vi.mock("./skills", () => ({
  localSkillDir: (name: string) => `/mock-skills/${name.toLowerCase().replace(/\s+/g, "-")}`,
  detectBundleDirs: () => [],
  registerLocalSkill: (name: string, desc: string, instructions: string, bundleDirs?: string[]) => {
    registeredSkills.push({ name, desc, instructions, bundleDirs });
    return {
      id: Date.now().toString(),
      name,
      description: desc,
      instructions,
      enabled: true,
      createdAt: new Date().toISOString(),
      scope: "local",
    };
  },
}));

import type { GithubApiItem } from "./github-bundle";
import {
  previewGithubBundle,
  importGithubBundle,
  isRepoAccessible,
  GithubError,
} from "./github-bundle";

// --- Helpers ---

function makeApiItem(name: string, type: "file" | "dir", dlUrl?: string): GithubApiItem {
  return {
    name,
    type,
    path: name,
    download_url: dlUrl ?? (type === "file" ? `https://raw.example.com/${name}` : null),
  };
}

function mockJsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map<string, string>(),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(JSON.stringify(data)).buffer),
  };
}

function mockTextResponse(text: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map<string, string>(),
    json: () => Promise.resolve(JSON.parse(text)),
    text: () => Promise.resolve(text),
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer),
  };
}

function mockBinaryResponse(buf: Buffer, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map<string, string>(),
    arrayBuffer: () =>
      Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
  };
}

function mockErrorResponse(status: number, headers?: Record<string, string>) {
  const h = new Map(Object.entries(headers ?? {}));
  return {
    ok: false,
    status,
    headers: { get: (k: string) => h.get(k) ?? null },
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(""),
  };
}

// --- Setup ---

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
  mockDirs.clear();
  mockFileContents.clear();
  registeredSkills.length = 0;
});

// ---------------------------------------------------------------------------
// previewGithubBundle
// ---------------------------------------------------------------------------

describe("previewGithubBundle", () => {
  it("detects skill names from SKILL.md frontmatter", async () => {
    // 1. Root directory listing
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse([
        makeApiItem("skills", "dir"),
        makeApiItem("workflow.json", "file", "https://raw.example.com/workflow.json"),
      ]),
    );

    // 2. skills/ directory listing
    mockFetch.mockResolvedValueOnce(mockJsonResponse([makeApiItem("summarize", "dir")]));

    // 3. SKILL.md metadata fetch
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        name: "SKILL.md",
        type: "file",
        path: "skills/summarize/SKILL.md",
        download_url: "https://raw.example.com/skills/summarize/SKILL.md",
      }),
    );

    // 4. SKILL.md content fetch
    mockFetch.mockResolvedValueOnce(
      mockTextResponse("---\nname: summarize\ndescription: Summarize docs\n---\nInstructions here"),
    );

    // 5. workflow.json content fetch
    mockFetch.mockResolvedValueOnce(
      mockTextResponse(JSON.stringify({ name: "Morning Briefing", steps: [] })),
    );

    const preview = await previewGithubBundle(null, "org", "repo", "bundle", "main");

    expect(preview.skillNames).toEqual(["summarize"]);
    expect(preview.automationNames).toEqual(["Morning Briefing"]);
    expect(preview._cached.rootItems).toHaveLength(2);
    expect(preview._cached.skillDirs).toHaveLength(1);
    expect(preview._cached.automationJsonContents).toHaveLength(1);
  });

  it("uses directory name as fallback when SKILL.md has no name field", async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse([makeApiItem("skills", "dir")]));
    mockFetch.mockResolvedValueOnce(mockJsonResponse([makeApiItem("my-tool", "dir")]));
    // SKILL.md metadata — no download_url
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        name: "SKILL.md",
        type: "file",
        path: "skills/my-tool/SKILL.md",
        download_url: null,
      }),
    );

    const preview = await previewGithubBundle(null, "org", "repo", "", "main");

    expect(preview.skillNames).toEqual(["my-tool"]);
  });

  it("caches automation JSON content for later import", async () => {
    const wfJson = JSON.stringify([
      { name: "WF1", steps: [{ id: "1", label: "Go", prompt: "Do it" }] },
      { name: "WF2", steps: [] },
    ]);

    mockFetch.mockResolvedValueOnce(
      mockJsonResponse([
        makeApiItem("workflows.json", "file", "https://raw.example.com/workflows.json"),
      ]),
    );
    mockFetch.mockResolvedValueOnce(mockTextResponse(wfJson));

    const preview = await previewGithubBundle(null, "org", "repo", "", "main");

    expect(preview.automationNames).toEqual(["WF1", "WF2"]);
    expect(preview._cached.automationJsonContents).toEqual([wfJson]);
  });

  it("throws GithubError on 401 auth failure", async () => {
    mockFetch.mockResolvedValueOnce(mockErrorResponse(401));

    await expect(previewGithubBundle(null, "org", "private-repo", "", "main")).rejects.toThrow(
      GithubError,
    );

    mockFetch.mockResolvedValueOnce(mockErrorResponse(401));
    const err = await previewGithubBundle(null, "org", "private-repo", "", "main").catch(
      (e: unknown) => e,
    );
    if (!(err instanceof GithubError)) throw new Error("expected GithubError");
    expect(err.code).toBe("auth");
  });

  it("throws GithubError on rate limit", async () => {
    mockFetch.mockResolvedValueOnce(mockErrorResponse(403, { "X-RateLimit-Remaining": "0" }));

    const err = await previewGithubBundle(null, "org", "repo", "", "main").catch((e: unknown) => e);
    if (!(err instanceof GithubError)) throw new Error("expected GithubError");
    expect(err.code).toBe("rate-limit");
  });

  it("sends Authorization header when token is provided", async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse([]));

    await previewGithubBundle("ghp_test123", "org", "repo", "", "main");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ghp_test123",
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// importGithubBundle
// ---------------------------------------------------------------------------

describe("importGithubBundle", () => {
  it("downloads skills and collects automation JSONs", async () => {
    // 1. Root directory listing
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse([
        makeApiItem("skills", "dir"),
        makeApiItem("workflow.json", "file", "https://raw.example.com/workflow.json"),
      ]),
    );

    // 2. skills/ directory listing
    mockFetch.mockResolvedValueOnce(mockJsonResponse([makeApiItem("summarize", "dir")]));

    // 3. SKILL.md metadata
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        name: "SKILL.md",
        type: "file",
        path: "skills/summarize/SKILL.md",
        download_url: "https://raw.example.com/skills/summarize/SKILL.md",
      }),
    );

    // 4. SKILL.md content
    mockFetch.mockResolvedValueOnce(
      mockTextResponse("---\nname: summarize\ndescription: Summarize docs\n---\nDo the summary"),
    );

    // 5. Download skill directory (recursive) — returns file list for the skill dir
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse([
        makeApiItem("SKILL.md", "file", "https://raw.example.com/SKILL.md"),
        makeApiItem("run.sh", "file", "https://raw.example.com/run.sh"),
      ]),
    );

    // 6. SKILL.md file download
    mockFetch.mockResolvedValueOnce(mockTextResponse("---\nname: summarize\n---\nInstructions"));

    // 7. run.sh file download
    mockFetch.mockResolvedValueOnce(mockTextResponse("#!/bin/bash\necho hello"));

    // 8. workflow.json content
    mockFetch.mockResolvedValueOnce(
      mockTextResponse(JSON.stringify({ name: "Test WF", steps: [] })),
    );

    const result = await importGithubBundle(null, "org", "repo", "bundle", "main");

    expect(result.skillsInstalled.map((s) => s.name)).toEqual(["summarize"]);
    expect(result.automationJsons).toHaveLength(1);
    expect(registeredSkills).toHaveLength(1);
    expect(registeredSkills[0].name).toBe("summarize");
  });

  it("uses cached preview data to avoid re-fetching", async () => {
    const cachedData = {
      rootItems: [
        makeApiItem("skills", "dir"),
        makeApiItem("wf.json", "file", "https://raw.example.com/wf.json"),
      ],
      skillDirs: [makeApiItem("my-skill", "dir")],
      automationJsonContents: ['{"name":"Cached WF","steps":[]}'],
    };

    // With cached data, only skill-specific fetches should happen:
    // 1. SKILL.md metadata for my-skill
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        name: "SKILL.md",
        type: "file",
        path: "skills/my-skill/SKILL.md",
        download_url: "https://raw.example.com/skills/my-skill/SKILL.md",
      }),
    );

    // 2. SKILL.md content
    mockFetch.mockResolvedValueOnce(
      mockTextResponse("---\nname: my-skill\ndescription: A skill\n---\nBody"),
    );

    // 3. Download skill dir contents
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse([makeApiItem("SKILL.md", "file", "https://raw.example.com/SKILL.md")]),
    );

    // 4. SKILL.md download
    mockFetch.mockResolvedValueOnce(mockTextResponse("---\nname: my-skill\n---\nBody"));

    const result = await importGithubBundle(null, "org", "repo", "bundle", "main", {
      cached: cachedData,
    });

    expect(result.skillsInstalled.map((s) => s.name)).toEqual(["my-skill"]);
    // Automation JSONs should come from cache, not re-fetched
    expect(result.automationJsons).toEqual(['{"name":"Cached WF","steps":[]}']);
    // Should NOT have fetched root directory or skills/ listing (those were cached)
    const fetchUrls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(fetchUrls.every((u) => !u.includes("/contents/?ref="))).toBe(true);
    expect(fetchUrls.every((u) => !u.includes("/contents/skills?ref="))).toBe(true);
  });

  it("skips existing skills when overwrite is false", async () => {
    // Pre-populate the skill directory
    mockDirs.add("/mock-skills/existing-skill");

    mockFetch.mockResolvedValueOnce(mockJsonResponse([makeApiItem("skills", "dir")]));
    mockFetch.mockResolvedValueOnce(mockJsonResponse([makeApiItem("existing-skill", "dir")]));
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        name: "SKILL.md",
        type: "file",
        path: "skills/existing-skill/SKILL.md",
        download_url: "https://raw.example.com/SKILL.md",
      }),
    );
    mockFetch.mockResolvedValueOnce(
      mockTextResponse("---\nname: existing-skill\ndescription: Exists\n---\nBody"),
    );

    const result = await importGithubBundle(null, "org", "repo", "", "main", {
      overwrite: false,
    });

    expect(result.skillsInstalled).toEqual([]);
    expect(registeredSkills).toHaveLength(0);
  });

  it("replaces existing skills when overwrite is true", async () => {
    mockDirs.add("/mock-skills/existing-skill");

    mockFetch.mockResolvedValueOnce(mockJsonResponse([makeApiItem("skills", "dir")]));
    mockFetch.mockResolvedValueOnce(mockJsonResponse([makeApiItem("existing-skill", "dir")]));
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        name: "SKILL.md",
        type: "file",
        path: "skills/existing-skill/SKILL.md",
        download_url: "https://raw.example.com/SKILL.md",
      }),
    );
    mockFetch.mockResolvedValueOnce(
      mockTextResponse("---\nname: existing-skill\ndescription: Updated\n---\nNew body"),
    );
    // Download skill dir
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse([makeApiItem("SKILL.md", "file", "https://raw.example.com/SKILL.md")]),
    );
    mockFetch.mockResolvedValueOnce(mockTextResponse("---\nname: existing-skill\n---\nNew body"));

    const result = await importGithubBundle(null, "org", "repo", "", "main", {
      overwrite: true,
    });

    expect(result.skillsInstalled.map((s) => s.name)).toEqual(["existing-skill"]);
    expect(registeredSkills).toHaveLength(1);
  });

  it("throws GithubError when no files found", async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse([]));

    await expect(importGithubBundle(null, "org", "repo", "", "main")).rejects.toThrow(GithubError);
  });

  it("handles binary files without corruption", async () => {
    // Root dir with a binary file
    mockFetch.mockResolvedValueOnce(mockJsonResponse([makeApiItem("skills", "dir")]));
    mockFetch.mockResolvedValueOnce(mockJsonResponse([makeApiItem("my-skill", "dir")]));
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        name: "SKILL.md",
        type: "file",
        path: "skills/my-skill/SKILL.md",
        download_url: "https://raw.example.com/SKILL.md",
      }),
    );
    mockFetch.mockResolvedValueOnce(
      mockTextResponse("---\nname: my-skill\ndescription: A skill\n---\nBody"),
    );

    // Download skill dir contents — includes a .png binary file
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse([
        makeApiItem("SKILL.md", "file", "https://raw.example.com/SKILL.md"),
        makeApiItem("icon.png", "file", "https://raw.example.com/icon.png"),
      ]),
    );

    // SKILL.md text download
    mockFetch.mockResolvedValueOnce(mockTextResponse("---\nname: my-skill\n---\nBody"));

    // icon.png binary download — raw bytes that would be corrupted by text encoding
    const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    mockFetch.mockResolvedValueOnce(mockBinaryResponse(binaryData));

    const result = await importGithubBundle(null, "org", "repo", "", "main");

    expect(result.skillsInstalled.map((s) => s.name)).toEqual(["my-skill"]);
    // The binary file should have been written as a Buffer, not a string
    const writtenFiles = [...mockFileContents.entries()];
    const pngFile = writtenFiles.find(([k]) => k.includes("icon.png"));
    expect(pngFile).toBeDefined();
    expect(Buffer.isBuffer(pngFile![1])).toBe(true);
  });

  it("preserves original skill on download failure (atomic swap)", async () => {
    // Pre-populate existing skill
    const existingDir = "/mock-skills/fragile-skill";
    mockDirs.add(existingDir);
    mockFileContents.set(existingDir + "/SKILL.md", "original content");

    mockFetch.mockResolvedValueOnce(mockJsonResponse([makeApiItem("skills", "dir")]));
    mockFetch.mockResolvedValueOnce(mockJsonResponse([makeApiItem("fragile-skill", "dir")]));
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        name: "SKILL.md",
        type: "file",
        path: "skills/fragile-skill/SKILL.md",
        download_url: "https://raw.example.com/SKILL.md",
      }),
    );
    mockFetch.mockResolvedValueOnce(
      mockTextResponse("---\nname: fragile-skill\ndescription: Desc\n---\nBody"),
    );
    // Fail the fetchDirectory call inside downloadDirRecursive (not individual file downloads,
    // which are silently caught). This simulates a network outage during directory listing.
    mockFetch.mockResolvedValueOnce(mockErrorResponse(500));

    // Import should continue (skill is skipped with warning), not crash
    const result = await importGithubBundle(null, "org", "repo", "", "main", {
      overwrite: true,
    });

    // Skill should not be installed due to download failure
    expect(result.skillsInstalled).toEqual([]);
    // Original directory should still exist with its content intact
    expect(mockDirs.has(existingDir)).toBe(true);
    expect(mockFileContents.get(existingDir + "/SKILL.md")).toBe("original content");
  });

  it("downloads resource files to resourcesDir", async () => {
    // Must include a .json automation file so import doesn't throw "no files found"
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse([
        makeApiItem("workflow.json", "file", "https://raw.example.com/workflow.json"),
        makeApiItem("config.yaml", "file", "https://raw.example.com/config.yaml"),
        makeApiItem("templates", "dir"),
      ]),
    );

    // automation.json content (required to pass the "no files" check)
    mockFetch.mockResolvedValueOnce(mockTextResponse(JSON.stringify({ name: "Test", steps: [] })));

    // config.yaml download
    mockFetch.mockResolvedValueOnce(mockTextResponse("key: value"));

    // templates/ dir listing
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse([makeApiItem("template.md", "file", "https://raw.example.com/template.md")]),
    );

    // template.md download
    mockFetch.mockResolvedValueOnce(mockTextResponse("# Template"));

    const result = await importGithubBundle(null, "org", "repo", "", "main", {
      resourcesDir: "/mock-resources",
    });

    expect(result.workingDir).toBe("/mock-resources");
    const configPath = path.join("/mock-resources", "config.yaml");
    expect(mockFileContents.has(configPath)).toBe(true);
  });

  it("handles multiple skills in a bundle", async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse([makeApiItem("skills", "dir")]));
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse([makeApiItem("skill-a", "dir"), makeApiItem("skill-b", "dir")]),
    );

    // skill-a SKILL.md metadata
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        name: "SKILL.md",
        type: "file",
        path: "skills/skill-a/SKILL.md",
        download_url: "https://raw.example.com/skill-a/SKILL.md",
      }),
    );
    mockFetch.mockResolvedValueOnce(
      mockTextResponse("---\nname: skill-a\ndescription: Skill A\n---\nA instructions"),
    );
    // skill-a dir download
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse([makeApiItem("SKILL.md", "file", "https://raw.example.com/SKILL.md")]),
    );
    mockFetch.mockResolvedValueOnce(mockTextResponse("---\nname: skill-a\n---\nA instructions"));

    // skill-b SKILL.md metadata
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        name: "SKILL.md",
        type: "file",
        path: "skills/skill-b/SKILL.md",
        download_url: "https://raw.example.com/skill-b/SKILL.md",
      }),
    );
    mockFetch.mockResolvedValueOnce(
      mockTextResponse("---\nname: skill-b\ndescription: Skill B\n---\nB instructions"),
    );
    // skill-b dir download
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse([makeApiItem("SKILL.md", "file", "https://raw.example.com/SKILL.md")]),
    );
    mockFetch.mockResolvedValueOnce(mockTextResponse("---\nname: skill-b\n---\nB instructions"));

    const result = await importGithubBundle(null, "org", "repo", "", "main");

    expect(result.skillsInstalled.map((s) => s.name)).toEqual(["skill-a", "skill-b"]);
    expect(registeredSkills).toHaveLength(2);
  });

  it("skips skill dirs without SKILL.md download_url", async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse([makeApiItem("skills", "dir")]));
    mockFetch.mockResolvedValueOnce(mockJsonResponse([makeApiItem("no-md", "dir")]));
    // SKILL.md metadata — no download_url
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        name: "SKILL.md",
        type: "file",
        path: "skills/no-md/SKILL.md",
        download_url: null,
      }),
    );

    const result = await importGithubBundle(null, "org", "repo", "", "main");

    expect(result.skillsInstalled).toEqual([]);
  });

  it("propagates auth errors from import", async () => {
    mockFetch.mockResolvedValueOnce(mockErrorResponse(401));

    await expect(importGithubBundle(null, "org", "private-repo", "", "main")).rejects.toThrow(
      GithubError,
    );
  });
});

// ---------------------------------------------------------------------------
// isRepoAccessible
// ---------------------------------------------------------------------------

describe("isRepoAccessible", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns accessible: true when repo responds 200", async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ id: 1 }));
    const result = await isRepoAccessible("token", "org", "repo");
    expect(result).toEqual({ accessible: true });
  });

  it("returns accessible: false for 404 without SSO header", async () => {
    mockFetch.mockResolvedValueOnce(mockErrorResponse(404));
    const result = await isRepoAccessible("token", "org", "repo");
    expect(result).toEqual({ accessible: false });
  });

  it("returns SSO URL when repo returns 403 with X-GitHub-SSO header", async () => {
    mockFetch.mockResolvedValueOnce(
      mockErrorResponse(403, {
        "X-GitHub-SSO": "required; url=https://github.com/orgs/myorg/sso",
      }),
    );
    const result = await isRepoAccessible("token", "myorg", "repo");
    expect(result).toEqual({
      accessible: false,
      ssoUrl: "https://github.com/orgs/myorg/sso",
    });
  });

  it("returns accessible: false without ssoUrl when SSO header has no URL", async () => {
    mockFetch.mockResolvedValueOnce(mockErrorResponse(403, { "X-GitHub-SSO": "required" }));
    const result = await isRepoAccessible("token", "org", "repo");
    expect(result).toEqual({ accessible: false, ssoUrl: undefined });
  });

  it("returns accessible: false when fetch throws (network error)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));
    const result = await isRepoAccessible("token", "org", "repo");
    expect(result).toEqual({ accessible: false });
  });
});
