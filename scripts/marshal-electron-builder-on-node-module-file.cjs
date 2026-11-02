const path = require("node:path");

// The Marshal Runtime type-checks service contract declarations with the bundled
// TypeScript compiler, which reads its own lib*.d.ts files at runtime. electron-builder
// drops every *.d.ts under node_modules unless this hook force-includes it; without
// them the Runtime host fails with "Cannot find name 'Promise'".
const TYPESCRIPT_LIB_SEGMENT = `${path.sep}node_modules${path.sep}typescript${path.sep}lib${path.sep}`;
const TYPESCRIPT_LIB_FILE = /^lib(\..+)?\.d\.ts$/;

module.exports = function onNodeModuleFile(filePath) {
  return (
    filePath.includes(TYPESCRIPT_LIB_SEGMENT) && TYPESCRIPT_LIB_FILE.test(path.basename(filePath))
  );
};
