import fs from "node:fs";
import path from "node:path";

import { dialog, shell } from "electron";

import {
  sanitizeSkillContent,
  type SanitizationWarning,
} from "../../common/foundation/skills/skill-sanitization";
import { createLogger } from "../../common/marshal-logger";
import { parseSkillMarkdown } from "../foundation/markdown/skill-markdown";
import { parseSkillMd } from "../github-bundle";
import { getNetFetch } from "../marshal-net-fetch";
import { stripSymlinks } from "../platform-security";
import {
  addSkill,
  updateSkill,
  deleteSkill,
  getSkillContent,
  localSkillDir,
  createSkillCache,
  saveSkills,
  registerLocalSkill,
  detectBundleDirs,
} from "../skills";
import { checkStringSize, IPC_LIMITS } from "./ipc-limits";
import type { IpcDeps } from "./types";
import { withTimeout } from "./with-timeout";

const log = createLogger("SkillsIpc");

const fetchImpl = getNetFetch();

/**
 * Validate a URL before attempting to import a skill from it.
 * Returns an error message if invalid, or null if OK.
 */
export function validateSkillUrl(url: string): string | null {
  let pathPart: string;
  try {
    pathPart = new URL(url).pathname;
  } catch {
    return "Not a valid URL.";
  }
  // Block GitHub HTML page URLs (blob/tree views). The /raw/ path is fine — GitHub serves raw content there.
  if (/^https?:\/\/github\.com\/.+\/(blob|tree)\//.test(url)) {
    return 'This is a GitHub page URL. Use the raw URL instead: on GitHub, click the "Raw" button and copy that URL.';
  }
  // Must point to a .md file
  if (!pathPart.endsWith(".md")) {
    return "URL must point to a .md file (e.g. SKILL.md).";
  }
  return null;
}

/**
 * Validate that parsed markdown content looks like a valid skill
 * (has frontmatter with at least a name field).
 */
export function validateSkillContent(content: string): string | null {
  if (!content.trim()) return "The fetched file is empty.";
  // Must have YAML frontmatter delimiters (aligned with parseSkillMarkdown's regex)
  if (!content.match(/^---\s*\n[\s\S]*?\n---\s*\n/)) {
    return "Not a valid skill file: missing YAML frontmatter (--- delimiters). Skills must start with a frontmatter block containing at least a name field.";
  }
  // Must have a name field in frontmatter
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/)?.[1] ?? "";
  if (!/^name:\s*.+$/m.test(frontmatter)) {
    return 'Not a valid skill file: frontmatter is missing a "name" field.';
  }
  return null;
}

export function registerSkillsHandlers({
  sessionManager,
  getWindow,
  ipcHandle,
}: Pick<IpcDeps, "sessionManager" | "getWindow" | "ipcHandle">) {
  ipcHandle("skills:list", async (_event, sessionId?: string) => {
    return { success: true, skills: sessionManager.listSkillsForSession(sessionId) };
  });

  ipcHandle(
    "skills:add",
    async (
      _event,
      name: string,
      description: string,
      instructions?: string,
      displayName?: string,
    ) => {
      try {
        const sanitized = sanitizeSkillContent(description, instructions ?? "");
        const skill = addSkill(
          name,
          sanitized.description,
          sanitized.instructions || undefined,
          displayName,
        );
        // Refresh current session to pick up new skill in system message
        const currentId = sessionManager.getCurrentSessionId();
        if (currentId) {
          log.info("Refreshing session to include new skill...");
          await withTimeout(30_000, sessionManager.refreshSession(currentId));
        }
        const win = getWindow();
        win?.webContents.send("skills:changed");
        return {
          success: true,
          skill,
          ...(sanitized.warnings.length > 0 && { warnings: sanitized.warnings }),
        };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  ipcHandle(
    "skills:update",
    async (
      _event,
      id: string,
      updates: { name?: string; description?: string; instructions?: string; enabled?: boolean },
    ) => {
      try {
        // Apply truncation and safety checks when content fields are being updated
        let warnings: ReturnType<typeof sanitizeSkillContent>["warnings"] = [];
        if (updates.description !== undefined || updates.instructions !== undefined) {
          const sanitized = sanitizeSkillContent(
            updates.description ?? "",
            updates.instructions ?? "",
          );
          if (updates.description !== undefined) updates.description = sanitized.description;
          if (updates.instructions !== undefined) updates.instructions = sanitized.instructions;
          warnings = sanitized.warnings;
        }
        const skill = updateSkill(id, updates);
        if (!skill) return { success: false, error: "Skill not found" };
        // Refresh current session to pick up skill changes in system message
        const currentId = sessionManager.getCurrentSessionId();
        if (currentId) {
          log.info("Refreshing session to reflect skill changes...");
          await withTimeout(30_000, sessionManager.refreshSession(currentId));
        }
        const win = getWindow();
        win?.webContents.send("skills:changed");
        return { success: true, skill, ...(warnings.length > 0 && { warnings }) };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  ipcHandle("skills:delete", async (_event, id: string) => {
    try {
      const deleted = deleteSkill(id);
      if (!deleted) return { success: false, error: "Skill not found" };
      // Refresh current session to remove deleted skill from system message
      const currentId = sessionManager.getCurrentSessionId();
      if (currentId) {
        log.info("Refreshing session to remove deleted skill...");
        await withTimeout(30_000, sessionManager.refreshSession(currentId));
      }
      const win = getWindow();
      win?.webContents.send("skills:changed");
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Community Skills IPC Handlers (GitHub-based catalog)

  ipcHandle("skills:export", async (_event, skillName: string) => {
    try {
      const content = getSkillContent(skillName);
      if (!content) return { success: false, error: "Skill file not found" };
      const result = await dialog.showSaveDialog({
        defaultPath: `${skillName}-SKILL.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (result.canceled || !result.filePath) return { success: false, error: "Cancelled" };
      await fs.promises.writeFile(result.filePath, content);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("skills:import-file", async () => {
    try {
      const result = await dialog.showOpenDialog({
        filters: [{ name: "Markdown", extensions: ["md"] }],
        properties: ["openFile"],
      });
      if (result.canceled || !result.filePaths[0]) return { success: false, error: "Cancelled" };
      const content = await fs.promises.readFile(result.filePaths[0], "utf-8");

      const contentError = validateSkillContent(content);
      if (contentError) return { success: false, error: contentError };

      const parsed = parseSkillMarkdown(content);
      const sanitized = sanitizeSkillContent(parsed.description, parsed.instructions);
      const skill = addSkill(parsed.name, sanitized.description, sanitized.instructions);
      const currentId = sessionManager.getCurrentSessionId();
      if (currentId) await withTimeout(30_000, sessionManager.refreshSession(currentId));
      const win = getWindow();
      win?.webContents.send("skills:changed");
      return {
        success: true,
        skill,
        ...(sanitized.warnings.length > 0 && { warnings: sanitized.warnings }),
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("skills:import-url", async (_event, url: string) => {
    try {
      const urlError = validateSkillUrl(url);
      if (urlError) return { success: false, error: urlError };

      const response = await fetchImpl(url);
      if (!response.ok)
        return {
          success: false,
          error: `Failed to fetch: ${response.status} ${response.statusText}`,
        };
      const content = await response.text();

      const contentError = validateSkillContent(content);
      if (contentError) return { success: false, error: contentError };

      const parsed = parseSkillMarkdown(content);
      const sanitized = sanitizeSkillContent(parsed.description, parsed.instructions);
      const skill = addSkill(parsed.name, sanitized.description, sanitized.instructions);
      const currentId = sessionManager.getCurrentSessionId();
      if (currentId) await withTimeout(30_000, sessionManager.refreshSession(currentId));
      const win = getWindow();
      win?.webContents.send("skills:changed");
      return {
        success: true,
        skill,
        ...(sanitized.warnings.length > 0 && { warnings: sanitized.warnings }),
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("skills:import-path", async (_event, filePath: string) => {
    try {
      if (!fs.existsSync(filePath)) return { success: false, error: "File not found" };
      const content = await fs.promises.readFile(filePath, "utf-8");

      const contentError = validateSkillContent(content);
      if (contentError) return { success: false, error: contentError };

      const parsed = parseSkillMarkdown(content);
      const sanitized = sanitizeSkillContent(parsed.description, parsed.instructions);
      const skill = addSkill(parsed.name, sanitized.description, sanitized.instructions);
      const currentId = sessionManager.getCurrentSessionId();
      if (currentId) await withTimeout(30_000, sessionManager.refreshSession(currentId));
      const win = getWindow();
      win?.webContents.send("skills:changed");
      return {
        success: true,
        skill,
        ...(sanitized.warnings.length > 0 && { warnings: sanitized.warnings }),
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle(
    "skills:import-contents",
    async (_event, files: Array<{ content: string; fileName: string }>) => {
      const MAX_BATCH_FILES = 50;

      if (files.length > MAX_BATCH_FILES) {
        return {
          success: false,
          succeeded: [],
          errors: [{ fileName: "(batch)", error: `Too many files (max ${MAX_BATCH_FILES})` }],
        };
      }

      const succeeded: Array<{ name: string; warnings?: SanitizationWarning[] }> = [];
      const errors: Array<{ fileName: string; error: string }> = [];

      // Pre-load skills once to avoid redundant disk I/O per file
      const cache = createSkillCache();

      for (const file of files) {
        try {
          const sizeCheck = checkStringSize(
            file.content,
            IPC_LIMITS.JSON_IMPORT_BYTES,
            "Skill content",
          );
          if (sizeCheck) {
            errors.push({ fileName: file.fileName, error: sizeCheck.error ?? "Content too large" });
            continue;
          }

          const contentError = validateSkillContent(file.content);
          if (contentError) {
            errors.push({ fileName: file.fileName, error: contentError });
            continue;
          }
          const parsed = parseSkillMarkdown(file.content);
          const sanitized = sanitizeSkillContent(parsed.description, parsed.instructions);
          const skill = addSkill(
            parsed.name,
            sanitized.description,
            sanitized.instructions,
            undefined,
            cache,
          );
          succeeded.push({
            name: skill.name,
            ...(sanitized.warnings.length > 0 && { warnings: sanitized.warnings }),
          });
        } catch (error) {
          errors.push({ fileName: file.fileName, error: String(error) });
        }
      }

      // Persist all new skills in one write + single session refresh
      if (succeeded.length > 0) {
        saveSkills(cache.localSkills);
        try {
          const currentId = sessionManager.getCurrentSessionId();
          if (currentId) await withTimeout(30_000, sessionManager.refreshSession(currentId));
          const win = getWindow();
          win?.webContents.send("skills:changed");
        } catch (err) {
          log.error("Session refresh after batch import failed:", err);
        }
      }

      return { success: succeeded.length > 0, succeeded, errors };
    },
  );

  ipcHandle("skills:openFile", async (_event, skillName: string) => {
    try {
      const skillPath = path.join(localSkillDir(skillName), "SKILL.md");
      if (!fs.existsSync(skillPath)) return { success: false, error: "Skill file not found" };
      const result = await shell.openPath(skillPath);
      if (result) return { success: false, error: result };
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("skills:import-bundle", async (_event, providedPath?: string) => {
    try {
      let dirPath: string;
      if (providedPath) {
        dirPath = providedPath;
      } else {
        const result = await dialog.showOpenDialog({
          title: "Select Skill Bundle Directory",
          properties: ["openDirectory"],
        });
        if (result.canceled || !result.filePaths[0]) {
          return { success: false, error: "Cancelled" };
        }
        dirPath = result.filePaths[0];
      }

      // Validate the directory contains a SKILL.md
      const skillMdPath = path.join(dirPath, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) {
        return {
          success: false,
          error: "Selected directory does not contain a SKILL.md file.",
        };
      }

      // Parse SKILL.md to get name and description
      const content = fs.readFileSync(skillMdPath, "utf-8");
      const { skillName, skillDesc, body } = parseSkillMd(content, path.basename(dirPath));

      // Check for conflicts
      const destDir = localSkillDir(skillName);
      if (fs.existsSync(destDir)) {
        const opts = {
          type: "question" as const,
          title: "Skill already exists",
          message: `A skill named "${skillName}" is already installed`,
          detail: "How would you like to proceed?",
          buttons: ["Skip", "Replace", "Cancel"],
          defaultId: 0,
          cancelId: 2,
        };
        const win = getWindow();
        const { response } = win
          ? await dialog.showMessageBox(win, opts)
          : await dialog.showMessageBox(opts);
        if (response === 2) return { success: false, error: "Import cancelled" };
        if (response === 0) return { success: false, error: "Skipped existing skill" };
        // response === 1 → replace
      }

      // Atomic copy: temp dir under same parent as destDir to avoid EXDEV on rename
      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      const tmpCopyDir = fs.mkdtempSync(path.join(path.dirname(destDir), ".m-skill-bundle-"));
      try {
        fs.cpSync(dirPath, tmpCopyDir, { recursive: true });
        // Strip symlinks before the swap so the live dir never contains them
        stripSymlinks(tmpCopyDir);
        // Backup-rename: move existing dir aside so we can restore on failure
        const backupDir = `${destDir}.bak`;
        if (fs.existsSync(destDir)) fs.renameSync(destDir, backupDir);
        try {
          fs.renameSync(tmpCopyDir, destDir);
          if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
        } catch (swapErr) {
          // Restore the backup if the swap failed
          fs.rmSync(tmpCopyDir, { recursive: true, force: true });
          if (fs.existsSync(backupDir)) fs.renameSync(backupDir, destDir);
          throw swapErr;
        }
      } catch (copyErr) {
        fs.rmSync(tmpCopyDir, { recursive: true, force: true });
        throw copyErr;
      }

      // Detect supporting directories that were included
      const bundleDirs = detectBundleDirs(destDir);

      // Sanitize content before registering (consistent with other import handlers)
      const sanitized = sanitizeSkillContent(skillDesc, body || skillDesc);

      // Register the skill in local metadata
      const skill = registerLocalSkill(
        skillName,
        sanitized.description,
        sanitized.instructions || sanitized.description,
        bundleDirs,
      );

      // Refresh session to pick up the new skill
      const currentId = sessionManager.getCurrentSessionId();
      if (currentId) {
        log.info("Refreshing session after bundle import...");
        await withTimeout(30_000, sessionManager.refreshSession(currentId));
      }
      const win = getWindow();
      win?.webContents.send("skills:changed");

      return {
        success: true,
        skill,
        bundleDirs,
        ...(sanitized.warnings.length > 0 && { warnings: sanitized.warnings }),
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}
