import * as fs from "fs";
import { tmpdir } from "os";
import * as path from "path";

import { dialog } from "electron";

import { sanitizeSkillContent } from "../../common/foundation/skills/skill-sanitization";
import { createLogger } from "../../common/marshal-logger";
import { getAppDataDir } from "../app-paths";
import { tryGetGhToken } from "../cli-path";
import {
  parseGithubUrl,
  previewGithubBundle,
  importGithubBundle,
  isRepoAccessible,
  parseSkillMd,
  GithubError,
} from "../github-bundle";
import { getCachedImportToken, setCachedImportToken, clearImportToken } from "../github-token";
import { stripSymlinks } from "../platform-security";
import { detectBundleDirs, localSkillDir, registerLocalSkill, type Skill } from "../skills";
import type { TenantPolicyProvider } from "../tenant-policy";
import { askHowToResolveInstallConflicts } from "./shared/install-conflict-prompt";
import type { IpcDeps } from "./types";
import { withTimeout } from "./with-timeout";

const TENANT_BLOCKED = "Automations are disabled by your organization's policy";

const log = createLogger("AutomationsDesktopIpc");

/** Directory where bundle resource files are installed */
const AUTOMATIONS_RESOURCES_DIR = path.join(getAppDataDir(), "marshal-automations", "resources");

/** Normalise a string to a safe directory name slug */
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Copy everything from `srcDir` that is not `skills/` and not a `*.json` file
 * into `destDir`. Returns the destDir path if anything was copied, null otherwise.
 */
function copyBundleResources(srcDir: string, destDir: string): string | null {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  let copied = false;
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === "skills") continue;
    if (!entry.isDirectory() && entry.name.endsWith(".json")) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    fs.mkdirSync(destDir, { recursive: true });
    fs.cpSync(src, dest, { recursive: true, force: true });
    stripSymlinks(dest);
    copied = true;
  }
  return copied ? destDir : null;
}

/**
 * Desktop-only install flows (local bundle dir, GitHub repo): orchestrate
 * skills + working-dir copies + symlink stripping. Cross-backend handlers
 * live in automations-ipc.ts.
 */
export function registerAutomationsDesktopHandlers({
  automationManager,
  getWindow,
  ipcHandle,
  tenantPolicyProvider,
}: Pick<IpcDeps, "automationManager" | "getWindow" | "ipcHandle"> & {
  // Optional: open-by-default so dev/test works without tenant wiring.
  // If omitted in production (wiring bug), enforcement is silently skipped.
  tenantPolicyProvider?: Pick<TenantPolicyProvider, "get">;
}) {
  ipcHandle("automations:importBundle", async () => {
    try {
      if (tenantPolicyProvider?.get()?.disableAutomations) {
        return { success: false, error: TENANT_BLOCKED };
      }
      const result = await dialog.showOpenDialog({
        title: "Select Automation Bundle Directory",
        properties: ["openDirectory"],
      });
      if (result.canceled || !result.filePaths[0]) {
        return { success: false, error: "Cancelled" };
      }
      const dirPath = result.filePaths[0];

      // --- Pre-scan for conflicts before touching the disk ---
      const skillConflicts: string[] = [];
      const automationConflicts: string[] = [];
      const existingAutomationNames = new Set(automationManager.list().map((w) => w.name));

      const skillsDir = path.join(dirPath, "skills");
      if (fs.existsSync(skillsDir)) {
        for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md");
          if (!fs.existsSync(skillMdPath)) continue;
          try {
            const content = fs.readFileSync(skillMdPath, "utf-8");
            const { skillName } = parseSkillMd(content, entry.name);
            if (fs.existsSync(localSkillDir(skillName))) skillConflicts.push(skillName);
          } catch {
            if (fs.existsSync(localSkillDir(entry.name))) skillConflicts.push(entry.name);
          }
        }
      }
      for (const file of fs.readdirSync(dirPath)) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(dirPath, file), "utf-8")) as unknown;
          const wfItems = (Array.isArray(raw) ? raw : [raw]) as Array<{ name?: string }>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- parsed from JSON, only .name accessed with typeof guard below
          for (const wf of wfItems) {
            if (typeof wf?.name === "string" && existingAutomationNames.has(wf.name)) {
              if (!automationConflicts.includes(wf.name)) automationConflicts.push(wf.name);
            }
          }
        } catch {
          /* ignore malformed files during pre-scan */
        }
      }

      // Show dialog if anything conflicts
      let overwrite = false;
      if (skillConflicts.length > 0 || automationConflicts.length > 0) {
        const choice = await askHowToResolveInstallConflicts(
          getWindow,
          skillConflicts,
          automationConflicts,
        );
        if (choice === "cancel") return { success: false, error: "Import cancelled" };
        overwrite = choice === "replace";
      }

      // --- Install skills ---
      const skillsInstalled: Skill[] = [];
      if (fs.existsSync(skillsDir)) {
        for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md");
          if (!fs.existsSync(skillMdPath)) continue;
          try {
            const content = fs.readFileSync(skillMdPath, "utf-8");
            // Use the block-scalar-aware parser (handles description: | multiline values)
            const { skillName, skillDesc, body } = parseSkillMd(content, entry.name);
            const srcDir = path.join(skillsDir, entry.name);
            const destDir = localSkillDir(skillName);
            if (fs.existsSync(destDir)) {
              if (!overwrite) {
                log.info(`[Automations] Skipping existing skill: ${skillName}`);
                continue;
              }
            }
            // Copy to a temp directory first, then swap atomically so a
            // failed copy doesn't destroy the user's existing skill.
            const tmpCopyDir = fs.mkdtempSync(path.join(tmpdir(), "m-skill-"));
            try {
              fs.cpSync(srcDir, tmpCopyDir, { recursive: true });
              // Strip symlinks before the swap so the live dir never contains them
              stripSymlinks(tmpCopyDir);
              // Ensure parent directory exists (first import on a fresh install)
              fs.mkdirSync(path.dirname(destDir), { recursive: true });
              // Backup-rename: move existing dir aside so we can restore on failure
              const backupDir = `${destDir}.bak`;
              if (fs.existsSync(destDir)) fs.renameSync(destDir, backupDir);
              try {
                fs.renameSync(tmpCopyDir, destDir);
                if (fs.existsSync(backupDir))
                  fs.rmSync(backupDir, { recursive: true, force: true });
              } catch (swapErr) {
                fs.rmSync(tmpCopyDir, { recursive: true, force: true });
                if (fs.existsSync(backupDir)) fs.renameSync(backupDir, destDir);
                throw swapErr;
              }
            } catch (copyErr) {
              fs.rmSync(tmpCopyDir, { recursive: true, force: true });
              throw copyErr;
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
            log.warn(`[Automations] Failed to install skill ${entry.name}:`, err);
          }
        }
      }

      // Notify renderer so skills panels reload with descriptions
      if (skillsInstalled.length > 0) {
        const win = getWindow();
        win?.webContents.send("skills:changed");
      }

      // --- Copy bundle resources (non-skills, non-json) to automation resources dir ---
      const bundleSlug = toSlug(path.basename(dirPath));
      const resourcesDestDir = path.join(AUTOMATIONS_RESOURCES_DIR, bundleSlug);
      const workingDir = copyBundleResources(dirPath, resourcesDestDir);
      if (workingDir) {
        log.info(`[Automations] Copied bundle resources to: ${workingDir}`);
      }

      // --- Import automation JSON files ---
      const skillNames = skillsInstalled.map((s) => s.name);
      const allAutomations: ReturnType<typeof automationManager.importAutomations> = [];
      for (const file of fs.readdirSync(dirPath)) {
        if (!file.endsWith(".json")) continue;
        try {
          const json = fs.readFileSync(path.join(dirPath, file), "utf-8");
          const imported = automationManager.importAutomations(json, {
            overwrite,
            ...(workingDir !== null && { workingDir }),
            ...(skillNames.length > 0 && { skillNames }),
          });
          allAutomations.push(...imported);
        } catch (err) {
          log.warn(`[Automations] Failed to import ${file}:`, err);
        }
      }

      return { success: true, skillsInstalled, automations: allAutomations };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("automations:importFromGithub", async (_e, url: string, paToken?: string) => {
    try {
      if (tenantPolicyProvider?.get()?.disableAutomations) {
        return { success: false, error: TENANT_BLOCKED };
      }
      const parsed = parseGithubUrl(url);
      if (!parsed) {
        return {
          success: false,
          error:
            "Invalid GitHub URL — paste a URL like https://github.com/org/repo/tree/main/automations",
        };
      }

      // Auth resolution: explicit PAT first (user override), then cached PAT, then gh CLI, then unauthenticated
      const token: string | null = paToken ?? getCachedImportToken() ?? tryGetGhToken() ?? null;

      // Preview the bundle to detect conflicts before downloading/installing anything
      let preview;
      try {
        log.info(
          `[GithubImport] Previewing ${parsed.owner}/${parsed.repo}/${parsed.path}@${parsed.branch} (token: ${token ? "yes" : "no"})`,
        );
        preview = await withTimeout(
          60_000,
          previewGithubBundle(token, parsed.owner, parsed.repo, parsed.path, parsed.branch),
        );
        log.info(
          `[GithubImport] Preview found ${preview.skillNames.length} skills, ${preview.automationNames.length} automations`,
        );
      } catch (err) {
        log.error("[GithubImport] Preview failed:", err instanceof Error ? err.message : err);
        if (err instanceof GithubError && (err.code === "auth" || err.code === "rate-limit")) {
          return { success: false, needsToken: true, error: err.message };
        }
        // Private repos return 404 when token is missing/expired — check repo access
        if (err instanceof GithubError && err.code === "not-found") {
          log.info("[GithubImport] Checking repo access...");
          const { accessible, ssoUrl } = await isRepoAccessible(token, parsed.owner, parsed.repo);
          log.info(`[GithubImport] Repo accessible: ${accessible}, ssoUrl: ${ssoUrl ?? "none"}`);
          if (!accessible) {
            let error: string;
            if (ssoUrl) {
              error = `Make sure you are signed in to your corporate GitHub account. Authorize at: ${ssoUrl}`;
            } else if (token) {
              error =
                "Token may be expired or lacks access to this repo — please re-authenticate. If this is an SSO-protected org, configure SSO for your token at GitHub Settings → Personal access tokens.";
            } else {
              error = "This may be a private repo — a GitHub token is required";
            }
            return { success: false, needsToken: true, error };
          }
          // Repo is accessible but path doesn't exist
          return {
            success: false,
            error: `Directory not found at "${parsed.path || "/"}" — check the path in your URL`,
          };
        }
        throw err;
      }

      const existingAutomationNames = new Set(automationManager.list().map((w) => w.name));
      const skillConflicts = preview.skillNames.filter((n) => fs.existsSync(localSkillDir(n)));
      const automationConflicts = preview.automationNames.filter((n) =>
        existingAutomationNames.has(n),
      );

      let overwrite = false;
      if (skillConflicts.length > 0 || automationConflicts.length > 0) {
        const choice = await askHowToResolveInstallConflicts(
          getWindow,
          skillConflicts,
          automationConflicts,
        );
        if (choice === "cancel") return { success: false, error: "Import cancelled" };
        overwrite = choice === "replace";
      }

      // Determine resource directory for this bundle (slug from owner/repo/path)
      const pathSlug = parsed.path ? toSlug(parsed.path.split("/").pop() ?? parsed.path) : "";
      const bundleSlug = toSlug(`${parsed.owner}-${parsed.repo}${pathSlug ? `-${pathSlug}` : ""}`);
      const githubResourcesDir = path.join(AUTOMATIONS_RESOURCES_DIR, bundleSlug);

      let importResult;
      try {
        log.info("[GithubImport] Downloading bundle...");
        importResult = await withTimeout(
          120_000,
          importGithubBundle(token, parsed.owner, parsed.repo, parsed.path, parsed.branch, {
            overwrite,
            resourcesDir: githubResourcesDir,
            cached: preview._cached,
          }),
        );
        log.info(
          `[GithubImport] Download complete: ${importResult.skillsInstalled.length} skills, ${importResult.automationJsons.length} automation files`,
        );
      } catch (err) {
        log.error("[GithubImport] Download failed:", err);
        if (err instanceof GithubError && (err.code === "auth" || err.code === "rate-limit")) {
          return { success: false, needsToken: true, error: err.message };
        }
        throw err;
      }

      const { skillsInstalled, automationJsons, workingDir } = importResult;

      // Token worked — persist it for future requests
      if (paToken) setCachedImportToken(paToken);

      // Notify renderer so skills panels reload with descriptions
      if (skillsInstalled.length > 0) {
        const win = getWindow();
        win?.webContents.send("skills:changed");
      }

      const skillNames = skillsInstalled.map((s) => s.name);
      const allAutomations: ReturnType<typeof automationManager.importAutomations> = [];
      for (const json of automationJsons) {
        try {
          const imported = automationManager.importAutomations(json, {
            overwrite,
            ...(workingDir !== undefined && { workingDir }),
            ...(skillNames.length > 0 && { skillNames }),
          });
          allAutomations.push(...imported);
        } catch (err) {
          log.warn("[GithubImport] Failed to import automation JSON:", err);
        }
      }

      return {
        success: true,
        skillsInstalled,
        automations: allAutomations,
        repoInfo: { owner: parsed.owner, repo: parsed.repo, path: parsed.path },
      };
    } catch (error) {
      log.error("[GithubImport] Import error:", error);
      if (error instanceof GithubError && (error.code === "auth" || error.code === "rate-limit")) {
        clearImportToken();
        return { success: false, needsToken: true, error: error.message };
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
