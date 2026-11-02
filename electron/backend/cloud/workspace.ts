import { execFile } from "node:child_process";
import { lstat, readFile, mkdtemp, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const excluded =
  /(^|\/)(?:\.env(?:\..*)?|\.git|node_modules|\.ssh|\.aws|\.azure|\.claude|\.codex|credentials(?:\..*)?|auth\.json|.*\.pem|.*\.key)$/i;
export async function captureCloudWorkspace(root: string) {
  const directory = await realpath(root);
  const gitRoot = (
    await exec("git", ["-C", directory, "rev-parse", "--show-toplevel"])
  ).stdout.trim();
  if ((await realpath(gitRoot)) !== directory)
    throw new Error("Cloud execution requires the repository root as the workspace");
  const listed = await exec(
    "git",
    ["-C", directory, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const files: Array<{ path: string; content: string; executable: boolean }> = [];
  const deleted: string[] = [];
  let size = 0;
  for (const relative of [...new Set(listed.stdout.split("\0").filter(Boolean))]) {
    if (excluded.test(relative)) continue;
    if (
      relative.startsWith("/") ||
      relative.includes("\\") ||
      relative.split("/").some((p) => p === ".." || p === ".git")
    )
      throw new Error("Unsafe workspace path");
    let current = directory;
    try {
      for (const component of relative.split("/")) {
        current = path.join(current, component);
        // oxlint-disable-next-line no-await-in-loop -- iterations are intentionally sequential
        if ((await lstat(current)).isSymbolicLink())
          throw new Error(`Cloud transfer does not support symlinks: ${relative}`);
      }
      // oxlint-disable-next-line no-await-in-loop -- iterations are intentionally sequential
      const stat = await lstat(current);
      if (!stat.isFile())
        throw new Error(`Cloud transfer does not support submodules: ${relative}`);
      if (stat.size > 1536 * 1024)
        throw new Error(`File exceeds cloud transfer limit: ${relative}`);
      // oxlint-disable-next-line no-await-in-loop -- iterations are intentionally sequential
      const content = (await readFile(current)).toString("base64");
      size += content.length;
      files.push({ path: relative, content, executable: !!(stat.mode & 0o111) });
    } catch (error) {
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
      if ((error as NodeJS.ErrnoException).code === "ENOENT") deleted.push(relative);
      else throw error;
    }
    if (size > 24 * 1024 * 1024 || files.length > 10000)
      throw new Error("Workspace exceeds cloud transfer limit");
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "marshal-cloud-bundle-"));
  try {
    const bundle = path.join(temporary, "source.bundle");
    await exec("git", ["-C", directory, "bundle", "create", bundle, "HEAD"]);
    const gitBundle = (await readFile(bundle)).toString("base64");
    if (size + gitBundle.length > 24 * 1024 * 1024)
      throw new Error("Git history and workspace exceed the 24 MiB cloud transfer limit");
    return { files, deleted, gitBundle };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
