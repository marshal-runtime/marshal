/**
 * GitHub repository bundle import.
 * Fetches automation .json files and installs skills from a GitHub directory
 * using the GitHub Contents API.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { readYamlField } from "../common/foundation/parsing/frontmatter";
import { sanitizeSkillContent } from "../common/foundation/skills/skill-sanitization";
import { createLogger } from "../common/marshal-logger";
import { descriptionFromBody } from "./foundation/yaml/skill-fields";
import { getNetFetch } from "./marshal-net-fetch";
import { stripSymlinks } from "./platform-security";
import { extractSsoUrl, isRateLimited } from "./platform/github-api-errors";
import { localSkillDir, detectBundleDirs, registerLocalSkill, type Skill } from "./skills";

const log = createLogger("GithubBundle");

const fetchImpl = getNetFetch();

export interface GithubApiItem {
  name: string;
  type: string;
  path: string;
  download_url: string | null;
}

export interface ParsedGithubUrl {
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

/**
 * Parse a GitHub URL into its components.
 * Handles:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/branch/path/to/dir
 *   github.com/owner/repo/tree/branch/path
 */
export function parseGithubUrl(url: string): ParsedGithubUrl | null {
  // Strip protocol and leading slashes
  let rest = url
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^\/\//, "");

  // Must start with github.com
  if (!rest.startsWith("github.com/")) return null;
  rest = rest.slice("github.com/".length);

  // Remove trailing slash
  rest = rest.replace(/\/$/, "");

  const parts = rest.split("/");
  if (parts.length < 2) return null;

  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) return null;

  // /tree/<branch>[/<path>]
  if (parts[2] === "tree" && parts[3]) {
    const branch = parts[3];
    const importPath = parts.slice(4).join("/");
    return { owner, repo, branch, path: importPath };
  }

  // Bare repo URL — use HEAD (GitHub resolves to default branch)
  return { owner, repo, branch: "HEAD", path: "" };
}

function buildHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

async function githubApiGet(
  url: string,
  token: string | null,
): Promise<GithubApiItem | GithubApiItem[]> {
  const resp = await fetchImpl(url, { headers: buildHeaders(token) });

  if (resp.status === 401 || resp.status === 403) {
    if (resp.status === 403 && isRateLimited(resp)) {
      throw new GithubError("rate-limit", "GitHub rate limit hit — try again later");
    }
    // SSO-protected orgs return 403 with X-GitHub-SSO header when token lacks SSO authorization
    const ssoHeader = resp.headers.get("X-GitHub-SSO");
    if (ssoHeader) {
      const ssoUrl = extractSsoUrl(ssoHeader);
      throw new GithubError(
        "auth",
        ssoUrl
          ? `Make sure you are signed in to your corporate GitHub account. Authorize at: ${ssoUrl}`
          : "Make sure you are signed in to your corporate GitHub account — go to GitHub Settings → Personal access tokens → Configure SSO",
      );
    }
    throw new GithubError(
      "auth",
      resp.status === 401
        ? "GitHub token is invalid or expired — please enter a new one"
        : "GitHub access denied — check that your token has the 'repo' scope and SSO is authorized if required",
    );
  }
  if (resp.status === 404) {
    throw new GithubError("not-found", "Directory not found — check the URL and your repo access");
  }
  if (!resp.ok) {
    throw new GithubError("api", `GitHub API error: ${resp.status}`);
  }

  const data: GithubApiItem | GithubApiItem[] = await resp.json();
  return data;
}

/**
 * Check whether a 404 is caused by an auth/token issue (private repo) vs a
 * genuinely missing path. Returns { accessible, ssoUrl? } so callers can
 * surface SSO guidance when a token lacks org authorization.
 */
export async function isRepoAccessible(
  token: string | null,
  owner: string,
  repo: string,
): Promise<{ accessible: boolean; ssoUrl?: string }> {
  try {
    const url = `https://api.github.com/repos/${owner}/${repo}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const resp = await fetchImpl(url, {
      headers: buildHeaders(token),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.ok) return { accessible: true };
    const ssoUrl = extractSsoUrl(resp.headers.get("X-GitHub-SSO"));
    return { accessible: false, ssoUrl };
  } catch {
    return { accessible: false };
  }
}

export class GithubError extends Error {
  constructor(
    public readonly code: "auth" | "not-found" | "rate-limit" | "api" | "no-files",
    message: string,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

async function fetchDirectory(
  token: string | null,
  owner: string,
  repo: string,
  dirPath: string,
  ref: string,
): Promise<GithubApiItem[]> {
  const encodedPath = dirPath ? `/${encodeURIComponent(dirPath).replace(/%2F/g, "/")}` : "";
  const url = `https://api.github.com/repos/${owner}/${repo}/contents${encodedPath}?ref=${ref}`;
  const result = await githubApiGet(url, token);
  if (!Array.isArray(result)) return [];
  return result;
}

async function fetchFileContent(downloadUrl: string, token: string | null): Promise<string> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const resp = await fetchImpl(downloadUrl, { headers });
  if (!resp.ok) throw new Error(`Failed to fetch file: ${resp.status}`);
  return resp.text();
}

/** Fetch a file as a binary Buffer (for non-text assets like images, PDFs, etc.). */
async function fetchFileBinary(downloadUrl: string, token: string | null): Promise<Buffer> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const resp = await fetchImpl(downloadUrl, { headers });
  if (!resp.ok) throw new Error(`Failed to fetch file: ${resp.status}`);
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

/** Known text file extensions that are safe to write as UTF-8. */
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".js",
  ".ts",
  ".mjs",
  ".cjs",
  ".jsx",
  ".tsx",
  ".css",
  ".html",
  ".htm",
  ".xml",
  ".svg",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".cmd",
  ".py",
  ".rb",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".gitignore",
  ".editorconfig",
  ".prettierrc",
  ".eslintrc",
  ".csv",
  ".log",
]);

function isTextFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || ext === "";
}

/**
 * Parse SKILL.md frontmatter for name and description.
 * Returns { skillName, skillDesc, body }.
 * Exported for shared use (local bundle import) and testing.
 */
export function parseSkillMd(
  content: string,
  fallbackName: string,
): { skillName: string; skillDesc: string; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  const fm = fmMatch?.[1] ?? "";
  const body = fmMatch?.[2]?.trim() ?? normalized;
  const skillName = readYamlField(fm, "name") ?? fallbackName;
  const skillDesc = readYamlField(fm, "description") ?? (descriptionFromBody(body) || skillName);
  return { skillName, skillDesc, body: body || skillDesc };
}

/**
 * Recursively download a GitHub directory tree to a local destination directory.
 * Text files are written as UTF-8; binary files are written as raw buffers.
 */
async function downloadDirRecursive(
  token: string | null,
  owner: string,
  repo: string,
  remotePath: string,
  ref: string,
  localDest: string,
): Promise<void> {
  const items = await fetchDirectory(token, owner, repo, remotePath, ref);
  for (const item of items) {
    // path.basename prevents path traversal via malicious filenames from the API
    const safeName = path.basename(item.name);
    if (!safeName || safeName === "." || safeName === "..") continue;

    if (item.type === "file" && item.download_url) {
      try {
        if (isTextFile(safeName)) {
          // eslint-disable-next-line no-await-in-loop -- sequential file operations
          const content = await fetchFileContent(item.download_url, token);
          fs.writeFileSync(path.join(localDest, safeName), content, "utf-8");
        } else {
          // eslint-disable-next-line no-await-in-loop -- sequential file operations
          const buf = await fetchFileBinary(item.download_url, token);
          fs.writeFileSync(path.join(localDest, safeName), buf);
        }
      } catch (err) {
        log.warn(`Failed to download ${item.path}:`, err);
      }
    } else if (item.type === "dir") {
      const subDest = path.join(localDest, safeName);
      fs.mkdirSync(subDest, { recursive: true });
      // eslint-disable-next-line no-await-in-loop -- sequential file operations
      await downloadDirRecursive(token, owner, repo, item.path, ref, subDest);
    }
  }
}

export interface GithubBundlePreview {
  /** Exact skill names (from SKILL.md name field, or dir name as fallback). */
  skillNames: string[];
  /** Automation names extracted from JSON files in the import directory. */
  automationNames: string[];
  /** Cached data from the preview phase, passed to import to avoid double-fetching. */
  _cached: {
    rootItems: GithubApiItem[];
    skillDirs: GithubApiItem[];
    automationJsonContents: string[];
  };
}

/**
 * Preview a GitHub bundle without installing anything.
 * Downloads SKILL.md files and automation JSONs to collect names for conflict detection.
 */
export async function previewGithubBundle(
  token: string | null,
  owner: string,
  repo: string,
  importPath: string,
  ref: string,
): Promise<GithubBundlePreview> {
  const items = await fetchDirectory(token, owner, repo, importPath, ref);
  const skillNames: string[] = [];
  const automationNames: string[] = [];
  let cachedSkillDirs: GithubApiItem[] = [];
  const cachedAutomationJsons: string[] = [];

  // Collect skill names from skills/ subdirectory
  const skillsDirItem = items.find((it) => it.type === "dir" && it.name === "skills");
  if (skillsDirItem) {
    const skillsPath = importPath ? `${importPath}/skills` : "skills";
    try {
      cachedSkillDirs = await fetchDirectory(token, owner, repo, skillsPath, ref);
      for (const skillDir of cachedSkillDirs) {
        if (skillDir.type !== "dir") continue;
        const skillDirPath = importPath
          ? `${importPath}/skills/${skillDir.name}`
          : `skills/${skillDir.name}`;
        try {
          const skillMdRemotePath = `${skillDirPath}/SKILL.md`;
          const skillMdUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(skillMdRemotePath).replace(/%2F/g, "/")}?ref=${ref}`;
          // eslint-disable-next-line no-await-in-loop -- sequential processing
          const skillMdResult = await githubApiGet(skillMdUrl, token);
          const skillMdItem = Array.isArray(skillMdResult) ? skillMdResult[0] : skillMdResult;
          if (skillMdItem?.download_url) {
            // eslint-disable-next-line no-await-in-loop -- sequential processing
            const content = await fetchFileContent(skillMdItem.download_url, token);
            const { skillName } = parseSkillMd(content, skillDir.name);
            skillNames.push(skillName);
          } else {
            skillNames.push(skillDir.name);
          }
        } catch {
          skillNames.push(skillDir.name);
        }
      }
    } catch {
      log.warn("Failed to list skills directory during preview");
    }
  }

  // Collect automation names from JSON files (cache the content for import)
  const jsonFiles = items.filter((it) => it.type === "file" && it.name.endsWith(".json"));
  for (const file of jsonFiles) {
    if (!file.download_url) continue;
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential file operations
      const content = await fetchFileContent(file.download_url, token);
      cachedAutomationJsons.push(content);
      const parsed: unknown = JSON.parse(content); // SF-4: trusted GitHub API content, parsed to unknown
      const wfItems: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const wf of wfItems) {
        if (wf !== null && typeof wf === "object" && "name" in wf) {
          const name: unknown = (wf as Record<string, unknown>).name; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by 'in' check
          if (typeof name === "string") {
            automationNames.push(name);
          }
        }
      }
    } catch {
      /* ignore malformed files */
    }
  }

  return {
    skillNames,
    automationNames,
    _cached: {
      rootItems: items,
      skillDirs: cachedSkillDirs,
      automationJsonContents: cachedAutomationJsons,
    },
  };
}

/**
 * Import automations and skills from a GitHub directory bundle.
 * Convention: skills/ subdirectory contains skill folders with SKILL.md.
 * All .json files in the root of the import path are treated as automations.
 * When `opts.overwrite` is false (default), existing skill directories are skipped.
 */
export async function importGithubBundle(
  token: string | null,
  owner: string,
  repo: string,
  importPath: string,
  ref: string,
  opts?: {
    overwrite?: boolean;
    resourcesDir?: string;
    /** Pre-fetched data from previewGithubBundle to avoid double-fetching. */
    cached?: GithubBundlePreview["_cached"];
  },
): Promise<{ skillsInstalled: Skill[]; automationJsons: string[]; workingDir?: string }> {
  // Use cached root items from preview if available, otherwise fetch
  const items =
    opts?.cached?.rootItems ?? (await fetchDirectory(token, owner, repo, importPath, ref));

  const skillsInstalled: Skill[] = [];
  const automationJsons: string[] = [];
  let skillsFound = 0;

  // Install skills from skills/ subdirectory
  const skillsDirItem = items.find((it) => it.type === "dir" && it.name === "skills");
  if (skillsDirItem) {
    const skillsPath = importPath ? `${importPath}/skills` : "skills";
    let skillDirs: GithubApiItem[] = [];
    if (opts?.cached?.skillDirs && opts.cached.skillDirs.length > 0) {
      skillDirs = opts.cached.skillDirs;
    } else {
      try {
        skillDirs = await fetchDirectory(token, owner, repo, skillsPath, ref);
      } catch {
        log.warn("Failed to list skills directory");
      }
    }

    for (const skillDir of skillDirs) {
      if (skillDir.type !== "dir") continue;
      skillsFound++;
      const skillDirPath = importPath
        ? `${importPath}/skills/${skillDir.name}`
        : `skills/${skillDir.name}`;
      try {
        // Peek at SKILL.md first to get name/description for metadata
        const skillMdRemotePath = `${skillDirPath}/SKILL.md`;
        const skillMdUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(skillMdRemotePath).replace(/%2F/g, "/")}?ref=${ref}`;
        // eslint-disable-next-line no-await-in-loop -- sequential processing
        const skillMdResult = await githubApiGet(skillMdUrl, token);
        const skillMdItem = Array.isArray(skillMdResult) ? skillMdResult[0] : skillMdResult;
        if (!skillMdItem?.download_url) {
          log.warn(`No SKILL.md in ${skillDir.name}, skipping`);
          continue;
        }
        // eslint-disable-next-line no-await-in-loop -- sequential processing
        const skillMdContent = await fetchFileContent(skillMdItem.download_url, token);
        const { skillName, skillDesc, body } = parseSkillMd(skillMdContent, skillDir.name);

        // Download the entire skill directory tree to ~/.marshal/marshal-skills/{name}/.
        // This preserves scripts/, sibling .md files, templates, schemas, etc. as real
        // files on disk so the AI can read and execute them via filesystem access.
        const destDir = localSkillDir(skillName);
        if (fs.existsSync(destDir)) {
          if (!opts?.overwrite) {
            log.info(`Skipping existing skill: ${skillName}`);
            continue;
          }
        }
        // Download to a temp directory first, then swap atomically so a
        // partial download doesn't destroy the user's existing skill.
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "m-skill-"));
        try {
          // eslint-disable-next-line no-await-in-loop -- sequential file operations
          await downloadDirRecursive(token, owner, repo, skillDirPath, ref, tmpDir);
          // Strip symlinks before the swap so the live dir never contains them
          stripSymlinks(tmpDir);
          // Ensure parent directory exists (first import on a fresh install)
          fs.mkdirSync(path.dirname(destDir), { recursive: true });
          // Backup-rename: move existing dir aside so we can restore on failure
          const backupDir = `${destDir}.bak`;
          if (fs.existsSync(destDir)) fs.renameSync(destDir, backupDir);
          try {
            fs.renameSync(tmpDir, destDir);
            if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
          } catch (swapErr) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            if (fs.existsSync(backupDir)) fs.renameSync(backupDir, destDir);
            throw swapErr;
          }
        } catch (downloadErr) {
          // Clean up temp dir on failure; original destDir is preserved
          fs.rmSync(tmpDir, { recursive: true, force: true });
          throw downloadErr;
        }

        const bundleDirs = detectBundleDirs(destDir);
        const sanitized = sanitizeSkillContent(skillDesc, body || skillDesc);
        const skill = registerLocalSkill(
          skillName,
          sanitized.description,
          sanitized.instructions || sanitized.description,
          bundleDirs,
        );
        skillsInstalled.push(skill);
      } catch (err) {
        log.warn(`Skipping skill ${skillDir.name}:`, err);
      }
    }
  }

  // Collect automation JSON files — use cached content from preview if available
  if (opts?.cached?.automationJsonContents && opts.cached.automationJsonContents.length > 0) {
    automationJsons.push(...opts.cached.automationJsonContents);
  } else {
    const jsonFiles = items.filter((it) => it.type === "file" && it.name.endsWith(".json"));
    if (jsonFiles.length === 0 && skillsFound === 0) {
      throw new GithubError("no-files", "No automation files found at that path");
    }
    for (const file of jsonFiles) {
      if (!file.download_url) continue;
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential file operations
        const content = await fetchFileContent(file.download_url, token);
        automationJsons.push(content);
      } catch (err) {
        log.warn(`Failed to fetch ${file.name}:`, err);
      }
    }
  }
  if (automationJsons.length === 0 && skillsFound === 0) {
    throw new GithubError("no-files", "No automation files found at that path");
  }

  // Download non-skills, non-json items (resource dirs, config files, templates, etc.)
  let workingDir: string | undefined;
  if (opts?.resourcesDir) {
    const resourceItems = items.filter(
      (it) =>
        !(it.type === "dir" && it.name === "skills") &&
        !(it.type === "file" && it.name.endsWith(".json")),
    );
    if (resourceItems.length > 0) {
      fs.mkdirSync(opts.resourcesDir, { recursive: true });
      for (const item of resourceItems) {
        const safeName = path.basename(item.name);
        if (!safeName || safeName === "." || safeName === "..") continue;
        try {
          if (item.type === "file" && item.download_url) {
            if (isTextFile(safeName)) {
              // eslint-disable-next-line no-await-in-loop -- sequential file operations
              const content = await fetchFileContent(item.download_url, token);
              fs.writeFileSync(path.join(opts.resourcesDir, safeName), content, "utf-8");
            } else {
              // eslint-disable-next-line no-await-in-loop -- sequential file operations
              const buf = await fetchFileBinary(item.download_url, token);
              fs.writeFileSync(path.join(opts.resourcesDir, safeName), buf);
            }
          } else if (item.type === "dir") {
            const subDest = path.join(opts.resourcesDir, safeName);
            fs.mkdirSync(subDest, { recursive: true });
            // eslint-disable-next-line no-await-in-loop -- sequential file operations
            await downloadDirRecursive(token, owner, repo, item.path, ref, subDest);
          }
        } catch (err) {
          log.warn(`Failed to download resource ${item.name}:`, err);
        }
      }
      workingDir = opts.resourcesDir;
      log.info(`Resources downloaded to: ${workingDir}`);
    }
  }

  return { skillsInstalled, automationJsons, workingDir };
}
