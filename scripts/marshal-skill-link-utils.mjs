// Marshal-owned path
import { lstatSync, readlinkSync, rmSync } from "node:fs";

const isWindows = process.platform === "win32";

export function isDirectoryLink(target, stat = lstatSync(target)) {
  if (stat.isSymbolicLink()) {
    return true;
  }

  if (!isWindows || !stat.isDirectory()) {
    return false;
  }

  try {
    readlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

export function removeLink(target) {
  rmSync(target, { recursive: true, force: true });
}
