import path from "node:path";

import { getAppDataDir } from "../app-paths";
import { GLOBAL_SKILLS_DIR, LOCAL_SKILLS_DIR } from "../skills";

/**
 * Directories every filesystem tool (SDK built-ins + the Marshal self-tools) may
 * read/write without a folder-grant card: installed skill resource dirs
 * (`~/.marshal/marshal-skills`, `~/.marshal/skills`) and the automations resource dir.
 *
 * These are *prefix* grants, so the dirs need not exist on disk — a missing root
 * grants nothing real (any read/write under it just fails ENOENT at the handler),
 * which is why this is a pure path computation with no `existsSync`: cheap enough
 * to run on every permission evaluation, and a dir created mid-session (e.g. the
 * automations resource dir on first use) is covered immediately. Tenant
 * `restrictToWorkspace` stripping is applied by the permission policy, not here.
 */
export function getFsResourceRoots(): string[] {
  return [
    LOCAL_SKILLS_DIR,
    GLOBAL_SKILLS_DIR,
    path.join(getAppDataDir(), "marshal-automations", "resources"),
  ];
}
