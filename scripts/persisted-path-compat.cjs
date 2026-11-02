"use strict";

const fs = require("node:fs");
const path = require("node:path");

function resolvePersistedPath(root, currentRelativePath, legacyRelativePaths) {
  const currentPath = path.join(root, currentRelativePath);
  if (fs.existsSync(currentPath)) return currentPath;
  const candidates = Array.isArray(legacyRelativePaths)
    ? legacyRelativePaths
    : [legacyRelativePaths];
  for (const legacyRelativePath of candidates) {
    const legacyPath = path.join(root, legacyRelativePath);
    if (fs.existsSync(legacyPath)) return legacyPath;
  }
  return currentPath;
}

module.exports = { resolvePersistedPath };

