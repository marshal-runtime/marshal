/** Discriminated union describing the three kinds of pill content. */
export type EntityPillKind =
  | { type: "person"; name: string; email?: string }
  | { type: "file"; name: string; extension?: string }
  | { type: "image"; name: string; dataUrl: string };

const friendlyFileTypes: Record<string, string> = {
  doc: "Word document",
  docx: "Word document",
  xls: "Excel spreadsheet",
  xlsx: "Excel spreadsheet",
  xlsm: "Excel spreadsheet",
  xlsb: "Excel spreadsheet",
  csv: "CSV file",
  ppt: "PowerPoint presentation",
  pptx: "PowerPoint presentation",
  ppsx: "PowerPoint slideshow",
  pdf: "PDF document",
  txt: "Text file",
  md: "Markdown file",
  log: "Log file",
  rtf: "Rich text document",
  png: "Image",
  jpg: "Image",
  jpeg: "Image",
  gif: "Image",
  webp: "Image",
  svg: "Image",
  bmp: "Image",
  ico: "Image",
  tif: "Image",
  tiff: "Image",
  heic: "Image",
  heif: "Image",
  avif: "Image",
  ai: "Illustrator file",
  eps: "Vector image",
  mp3: "Audio",
  wav: "Audio",
  flac: "Audio",
  m4a: "Audio",
  aac: "Audio",
  ogg: "Audio",
  oga: "Audio",
  mp4: "Video",
  mov: "Video",
  mkv: "Video",
  avi: "Video",
  webm: "Video",
  m4v: "Video",
  wmv: "Video",
  eml: "Email message",
  msg: "Email message",
  ics: "Calendar event",
  vcf: "Contact card",
  html: "Web page",
  htm: "Web page",
  json: "JSON file",
  yml: "YAML file",
  yaml: "YAML file",
  xml: "XML file",
  ts: "TypeScript file",
  tsx: "TypeScript file",
  js: "JavaScript file",
  jsx: "JavaScript file",
  mjs: "JavaScript file",
  cjs: "JavaScript file",
  py: "Python file",
  rb: "Ruby file",
  go: "Go file",
  rs: "Rust file",
  java: "Java file",
  kt: "Kotlin file",
  swift: "Swift file",
  c: "C source file",
  h: "C header file",
  cc: "C++ source file",
  cpp: "C++ source file",
  hpp: "C++ header file",
  cs: "C# source file",
  php: "PHP file",
  sh: "Shell script",
  ps1: "PowerShell script",
  css: "Stylesheet",
  scss: "Stylesheet",
  sass: "Stylesheet",
  less: "Stylesheet",
  loop: "Loop page",
  fluid: "Loop page",
  vsd: "Visio diagram",
  vsdx: "Visio diagram",
  vssx: "Visio stencil",
  vstx: "Visio template",
  mpp: "Project plan",
  pub: "Publisher document",
  accdb: "Access database",
  mdb: "Access database",
};

export function friendlyFileType(extension?: string): string {
  if (!extension) return "File";
  const ext = extension.toLowerCase().replace(/^\./, "");
  return friendlyFileTypes[ext] ?? `.${ext} file`;
}

/**
 * Display label for a kind, used by the pill body.
 *
 * All branches return `kind.name` today; the exhaustive switch is the
 * extension point for richer per-kind labels in the picker UI PR (e.g.
 * `"Ada Lovelace <ada@…>"` for `person`).
 */
export function entityPillLabel(kind: EntityPillKind): string {
  switch (kind.type) {
    case "person":
      return kind.name;
    case "file":
    case "image":
      return kind.name;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
