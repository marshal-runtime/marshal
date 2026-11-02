// Monaco language ids are names ("typescript"), not file extensions ("ts").
// Extensions that equal their language id (json, css, go, sql…) fall through.
const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json5: "json",
  jsonc: "json",
  py: "python",
  pyi: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  fs: "fsharp",
  c: "c",
  h: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  m: "objective-c",
  pl: "perl",
  ps1: "powershell",
  psm1: "powershell",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  bat: "bat",
  cmd: "bat",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
  htm: "html",
  vue: "html",
  svg: "xml",
  plist: "xml",
  xsd: "xml",
  xsl: "xml",
  conf: "ini",
  cfg: "ini",
  toml: "ini",
  properties: "ini",
  tf: "hcl",
  gql: "graphql",
  proto: "protobuf",
  tex: "latex",
  dockerfile: "dockerfile",
};

const FILE_NAME_LANGUAGE: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "shell",
  ".bashrc": "shell",
  ".zshrc": "shell",
  ".gitignore": "ini",
  ".env": "ini",
};

export function monacoLanguageForFile(fileName: string): string {
  const baseName = fileName.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const byName = FILE_NAME_LANGUAGE[baseName];
  if (byName) return byName;
  const dotIndex = baseName.lastIndexOf(".");
  if (dotIndex <= 0) return "plaintext";
  const extension = baseName.slice(dotIndex + 1);
  return EXTENSION_LANGUAGE[extension] ?? extension;
}
