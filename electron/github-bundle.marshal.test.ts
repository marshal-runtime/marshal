// Marshal-owned test
import { describe, expect, it, vi } from "vitest";

vi.mock("./app-paths", () => ({
  getAppDataDir: () => "/home/user/.marshal",
}));

import { parseGithubUrl, parseSkillMd } from "./github-bundle";

// ---------------------------------------------------------------------------
// parseGithubUrl
// ---------------------------------------------------------------------------

describe("parseGithubUrl", () => {
  it("parses a full tree URL with path", () => {
    const r = parseGithubUrl("https://github.com/org/repo/tree/main/workflows");
    expect(r).toEqual({ owner: "org", repo: "repo", branch: "main", path: "workflows" });
  });

  it("parses a tree URL with nested path", () => {
    const r = parseGithubUrl("https://github.com/org/repo/tree/main/a/b/c");
    expect(r).toEqual({ owner: "org", repo: "repo", branch: "main", path: "a/b/c" });
  });

  it("parses a bare repo URL (no tree segment)", () => {
    const r = parseGithubUrl("https://github.com/org/repo");
    expect(r).toEqual({ owner: "org", repo: "repo", branch: "HEAD", path: "" });
  });

  it("parses without https:// protocol", () => {
    const r = parseGithubUrl("github.com/org/repo/tree/develop/skills");
    expect(r).toEqual({ owner: "org", repo: "repo", branch: "develop", path: "skills" });
  });

  it("strips trailing slash", () => {
    const r = parseGithubUrl("https://github.com/org/repo/tree/main/workflows/");
    expect(r).toEqual({ owner: "org", repo: "repo", branch: "main", path: "workflows" });
  });

  it("returns null for non-github URLs", () => {
    expect(parseGithubUrl("https://gitlab.com/org/repo")).toBeNull();
  });

  it("returns null for a URL with only owner (no repo)", () => {
    expect(parseGithubUrl("https://github.com/org")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseGithubUrl("")).toBeNull();
  });

  it("parses a branch name that contains hyphens", () => {
    const r = parseGithubUrl("https://github.com/org/repo/tree/feat/my-branch/dir");
    // parts[3] = "feat", rest = "my-branch/dir" — branch is first segment after tree/
    expect(r).toEqual({ owner: "org", repo: "repo", branch: "feat", path: "my-branch/dir" });
  });
});

// ---------------------------------------------------------------------------
// parseSkillMd
// ---------------------------------------------------------------------------

describe("parseSkillMd", () => {
  it("parses name, description, and body", () => {
    const md = `---\nname: my-skill\ndescription: A description\n---\n\nBody content here`;
    const r = parseSkillMd(md, "fallback");
    expect(r.skillName).toBe("my-skill");
    expect(r.skillDesc).toBe("A description");
    expect(r.body).toBe("Body content here");
  });

  it("uses fallback name when name field is absent", () => {
    const md = `---\ndescription: Desc\n---\nBody`;
    const r = parseSkillMd(md, "fallback-name");
    expect(r.skillName).toBe("fallback-name");
  });

  it("derives description from body when frontmatter has none", () => {
    const md = `---\nname: my-skill\n---\nBody`;
    const r = parseSkillMd(md, "fallback");
    expect(r.skillDesc).toBe("Body");
  });

  it("falls back to skill name when body is also empty", () => {
    const md = `---\nname: my-skill\n---\n`;
    const r = parseSkillMd(md, "fallback");
    expect(r.skillDesc).toBe("my-skill");
  });

  it("handles quoted description", () => {
    const md = `---\nname: pptx\ndescription: "Use this skill for .pptx files"\n---\nInstructions`;
    const r = parseSkillMd(md, "fallback");
    expect(r.skillDesc).toBe("Use this skill for .pptx files");
  });

  it("handles block scalar description", () => {
    const md = `---\nname: my-skill\ndescription: |\n  Multi-line\n  description\n---\nBody`;
    const r = parseSkillMd(md, "fallback");
    expect(r.skillDesc).toBe("Multi-line\ndescription");
  });

  it("falls back to full content when there is no frontmatter", () => {
    const md = "Just plain content with no frontmatter";
    const r = parseSkillMd(md, "fallback");
    expect(r.body).toBe("Just plain content with no frontmatter");
  });

  it("uses skillDesc as body when body is empty", () => {
    const md = `---\nname: my-skill\ndescription: A description\n---\n`;
    const r = parseSkillMd(md, "fallback");
    expect(r.body).toBe("A description");
  });
});
