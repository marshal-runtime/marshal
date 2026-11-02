/**
 * Phone and desktop views for `runtimeShowUi`. A render declares the client
 * viewports it serves in the reserved `marshalViewports` prop (authored renders
 * have no metadata record — see common/runtime-ui-viewports.ts); the renderer
 * gate refuses to mount it elsewhere and offers the "ask for a view" request.
 *
 * When the two viewports use different sources, a generated wrapper entry
 * imports both and picks one from the host-injected `marshalViewport` prop.
 * Each render's views are recorded next to its sources so a later call can add
 * the missing view while keeping the existing one.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  AUTHORED_UI_CLIENT_VIEWPORT_PROP,
  AUTHORED_UI_VIEWPORTS_PROP,
  type MarshalUiViewport,
} from "../../common/runtime-ui-viewports";
import { secureAtomicWriteFileSync } from "../platform-security";
import {
  BUILTIN_UI_COMPONENT_NAMES,
  type BuiltinUiComponentName,
  getBuiltinComponentSource,
  isBuiltinUiComponentName,
  validateBuiltinComponentProps,
} from "./show-ui-components";

export const UI_VIEWPORTS: readonly MarshalUiViewport[] = Object.freeze(["desktop", "mobile"]);
const UI_DIR = [".agent", "ui"] as const;
const MAX_TSX_BYTES = 512 * 1024;

export type ShowUiViewSpec =
  | { readonly kind: "tsx"; readonly tsx: string }
  | { readonly kind: "component"; readonly name: BuiltinUiComponentName }
  /** Source already in the compile root; `path` is relative to it. */
  | { readonly kind: "file"; readonly path: string };

export type ShowUiViews = Partial<Record<MarshalUiViewport, ShowUiViewSpec>>;

/** A file named by the call, not yet imported into the compile root. */
export interface ShowUiFileRequest {
  readonly kind: "file-request";
  readonly file: string;
}

export type ShowUiRequestedViews = Partial<
  Record<MarshalUiViewport, ShowUiViewSpec | ShowUiFileRequest>
>;

/** Workspace-relative source file of each view. */
export type ShowUiViewPaths = Partial<Record<MarshalUiViewport, string>>;

export interface ShowUiRecord {
  readonly title: string;
  readonly props: Record<string, unknown>;
  readonly views: ShowUiViews;
  readonly viewPaths?: ShowUiViewPaths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isViewport(value: unknown): value is MarshalUiViewport {
  return value === "mobile" || value === "desktop";
}

function parseSpec(value: unknown, label: string): ShowUiViewSpec | ShowUiFileRequest {
  if (!isRecord(value)) {
    throw new Error(`runtimeShowUi ${label} must be {tsx}, {file}, or {component}.`);
  }
  const hasTsx = typeof value.tsx === "string" && value.tsx.trim().length > 0;
  const hasFile = typeof value.file === "string" && value.file.trim().length > 0;
  const hasComponent = value.component !== undefined;
  if (Number(hasTsx) + Number(hasFile) + Number(hasComponent) !== 1) {
    throw new Error(`runtimeShowUi ${label} needs exactly one of tsx, file, or component.`);
  }
  if (typeof value.file === "string" && hasFile) {
    return { kind: "file-request", file: value.file.trim() };
  }
  if (hasComponent) {
    if (!isBuiltinUiComponentName(value.component)) {
      throw new Error(
        `runtimeShowUi ${label}.component must be one of: ${BUILTIN_UI_COMPONENT_NAMES.join(", ")}.`,
      );
    }
    return { kind: "component", name: value.component };
  }
  const tsx = typeof value.tsx === "string" ? value.tsx : "";
  if (Buffer.byteLength(tsx, "utf8") > MAX_TSX_BYTES) {
    throw new Error(`runtimeShowUi ${label}.tsx exceeds ${MAX_TSX_BYTES} bytes.`);
  }
  return { kind: "tsx", tsx };
}

/**
 * `views: {desktop?, mobile?}` is the full form. The `tsx`/`component`
 * shorthand gives one source for `viewports` (default: the client the turn
 * came from). Returns an empty object when the call names no source, which is
 * valid only when refreshing an existing view.
 */
export function parseViewsArgs(
  args: Readonly<Record<string, unknown>>,
  defaultViewport: MarshalUiViewport,
): ShowUiRequestedViews {
  const hasShorthand =
    args.tsx !== undefined || args.file !== undefined || args.component !== undefined;
  if (args.views !== undefined) {
    if (hasShorthand) throw new Error("runtimeShowUi takes views or tsx/file/component, not both.");
    if (!isRecord(args.views)) throw new Error("runtimeShowUi views must be an object.");
    const views: ShowUiRequestedViews = {};
    for (const [key, value] of Object.entries(args.views)) {
      if (!isViewport(key)) throw new Error("runtimeShowUi views keys must be desktop or mobile.");
      views[key] = parseSpec(value, `views.${key}`);
    }
    return views;
  }
  if (!hasShorthand) return {};
  const spec = parseSpec({ tsx: args.tsx, file: args.file, component: args.component }, "source");
  const viewports = args.viewports === undefined ? [defaultViewport] : args.viewports;
  if (!Array.isArray(viewports) || viewports.length === 0 || !viewports.every(isViewport)) {
    throw new Error('runtimeShowUi viewports must be a non-empty array of "desktop"/"mobile".');
  }
  return Object.fromEntries(viewports.map((viewport) => [viewport, spec]));
}

export function validateViewProps(
  views: ShowUiViews,
  props: Record<string, unknown>,
): { readonly message: string } | undefined {
  for (const spec of Object.values(views)) {
    if (spec?.kind !== "component") continue;
    const validation = validateBuiltinComponentProps(spec.name, props);
    if (!validation.ok) return validation.error;
  }
  return undefined;
}

export function declaredViewports(views: ShowUiRequestedViews): MarshalUiViewport[] {
  return UI_VIEWPORTS.filter((viewport) => views[viewport] !== undefined);
}

export function renderProps(
  props: Record<string, unknown>,
  views: ShowUiViews,
): Record<string, unknown> {
  const {
    [AUTHORED_UI_VIEWPORTS_PROP]: _declared,
    [AUTHORED_UI_CLIENT_VIEWPORT_PROP]: _client,
    ...rest
  } = props;
  return { ...rest, [AUTHORED_UI_VIEWPORTS_PROP]: declaredViewports(views) };
}

function sourceOf(spec: Exclude<ShowUiViewSpec, { kind: "file" }>): string {
  return spec.kind === "tsx" ? spec.tsx : getBuiltinComponentSource(spec.name);
}

function sameSource(left: ShowUiViewSpec, right: ShowUiViewSpec): boolean {
  if (left.kind === "file" || right.kind === "file") {
    return left.kind === "file" && right.kind === "file" && left.path === right.path;
  }
  return sourceOf(left) === sourceOf(right);
}

export interface ShowUiSourceFile {
  readonly relativePath: string;
  readonly source: string;
}

/**
 * Plans the files to write: one file when every view shares a source,
 * otherwise one file per view plus a wrapper entry that switches on the
 * host-injected client viewport.
 */
export function planSourceFiles(
  views: ShowUiViews,
  entryPathFor: (label: string, source: string) => string,
  label: string,
): {
  readonly entryPath: string;
  readonly files: readonly ShowUiSourceFile[];
  readonly viewPaths: ShowUiViewPaths;
} {
  const desktop = views.desktop;
  const mobile = views.mobile;
  const only = desktop ?? mobile;
  if (!only) throw new Error("runtimeShowUi needs at least one view.");
  const place = (spec: ShowUiViewSpec, viewLabel: string) => {
    if (spec.kind === "file") return { path: spec.path, files: [] };
    const source = sourceOf(spec);
    const relativePath = entryPathFor(viewLabel, source);
    return { path: relativePath, files: [{ relativePath, source }] };
  };
  if (!desktop || !mobile || sameSource(desktop, mobile)) {
    const placed = place(only, label);
    const viewPaths = Object.fromEntries(
      declaredViewports(views).map((viewport) => [viewport, placed.path]),
    );
    return { entryPath: placed.path, files: placed.files, viewPaths };
  }
  const desktopPlaced = place(desktop, `${label}-desktop`);
  const mobilePlaced = place(mobile, `${label}-mobile`);
  const importPath = (file: string) => {
    const relative = path.posix.relative(UI_DIR.join("/"), file).replace(/\.[jt]sx?$/, "");
    return relative.startsWith(".") ? relative : `./${relative}`;
  };
  const wrapper = [
    `import DesktopView from "${importPath(desktopPlaced.path)}";`,
    `import MobileView from "${importPath(mobilePlaced.path)}";`,
    "",
    "export default function ViewportViews(props: any) {",
    `  return props.${AUTHORED_UI_CLIENT_VIEWPORT_PROP} === "mobile" ? <MobileView {...props} /> : <DesktopView {...props} />;`,
    "}",
    "",
  ].join("\n");
  const entryPath = entryPathFor(`${label}-views`, wrapper);
  return {
    entryPath,
    files: [
      ...desktopPlaced.files,
      ...mobilePlaced.files,
      { relativePath: entryPath, source: wrapper },
    ],
    viewPaths: { desktop: desktopPlaced.path, mobile: mobilePlaced.path },
  };
}

function isViewSourcePath(value: unknown): value is string {
  if (typeof value !== "string" || !/\.[jt]sx?$/.test(value)) return false;
  const segments = value.split("/");
  return segments[0] === UI_DIR[0] && segments[1] === UI_DIR[1] && !segments.includes("..");
}

/**
 * The views to keep when a refresh omits them, read back from their source
 * files: the files are live (the renderer recompiles on change), so an agent
 * may have edited one in place, and that edit must survive the refresh.
 */
export function viewsFromSourceFiles(workspacePath: string, record: ShowUiRecord): ShowUiViews {
  const views: ShowUiViews = { ...record.views };
  for (const viewport of declaredViewports(record.views)) {
    const relativePath = record.viewPaths?.[viewport];
    const spec = record.views[viewport];
    // A file view keeps its path: its imports sit beside it, so edits stay live there.
    if (!relativePath || !spec || spec.kind === "file") continue;
    let onDisk: string;
    try {
      onDisk = readFileSync(path.join(workspacePath, ...relativePath.split("/")), "utf8");
    } catch {
      continue;
    }
    if (onDisk.trim() && onDisk !== sourceOf(spec)) views[viewport] = { kind: "tsx", tsx: onDisk };
  }
  return views;
}

function recordPath(workspacePath: string, renderId: string): string {
  const safe = renderId.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(workspacePath, ...UI_DIR, "renders", `${safe}.json`);
}

export function writeShowUiRecord(workspacePath: string, renderId: string, value: ShowUiRecord) {
  secureAtomicWriteFileSync(recordPath(workspacePath, renderId), JSON.stringify(value), {
    mode: 0o600,
  });
}

export function readShowUiRecord(
  workspacePath: string,
  renderId: string,
): ShowUiRecord | undefined {
  let parsed: unknown;
  try {
    // SF-4: every field is validated below before use.
    parsed = JSON.parse(readFileSync(recordPath(workspacePath, renderId), "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.title !== "string" || !isRecord(parsed.props)) {
    return undefined;
  }
  if (!isRecord(parsed.views)) return undefined;
  const views: ShowUiViews = {};
  for (const viewport of UI_VIEWPORTS) {
    const spec = parsed.views[viewport];
    if (!isRecord(spec)) continue;
    if (spec.kind === "tsx" && typeof spec.tsx === "string") {
      views[viewport] = { kind: "tsx", tsx: spec.tsx };
    } else if (spec.kind === "component" && isBuiltinUiComponentName(spec.name)) {
      views[viewport] = { kind: "component", name: spec.name };
    } else if (spec.kind === "file" && isViewSourcePath(spec.path)) {
      views[viewport] = { kind: "file", path: spec.path };
    }
  }
  const viewPaths: ShowUiViewPaths = {};
  if (isRecord(parsed.viewPaths)) {
    for (const viewport of UI_VIEWPORTS) {
      const candidate = parsed.viewPaths[viewport];
      if (isViewSourcePath(candidate)) viewPaths[viewport] = candidate;
    }
  }
  return {
    title: parsed.title,
    props: parsed.props,
    views,
    ...(Object.keys(viewPaths).length > 0 ? { viewPaths } : {}),
  };
}
