import {
  AUTHORED_UI_CLIENT_VIEWPORT_PROP,
  AUTHORED_UI_VIEWPORTS_PROP,
  DESKTOP_ONLY_VIEWPORTS,
  parseUiViewports,
  type MarshalUiViewport,
} from "@common/runtime-ui-viewports";

import { createPackagedUiDocument } from "./packagedUiDocument";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The renderer template mounts the compiled component in a nested srcdoc
 * frame, which inherits the window's header CSP — a hash-pinned script-src
 * under which the component's own inline scripts can never execute. Route the
 * component document through the same packaged-UI sandbox as the outer frame:
 * scripts are neutralized and re-executed as blob: sources by the sandbox
 * bootstrap, whose hash every policy in the chain already allows. The
 * template's placeholder metas (marshal-props/storage/runtime) are plain named
 * metas the sandbox rewrite preserves, so its bootstrap substitution still
 * applies.
 */
export function sandboxAuthoredComponentHtml(
  output: Record<string, unknown>,
  registerChildNonce?: (nonce: string) => void,
  gate?: {
    readonly viewport: MarshalUiViewport;
    readonly onMissing?: (viewport: MarshalUiViewport) => void;
  },
): Record<string, unknown> {
  const structured = isRecord(output.structuredContent) ? output.structuredContent : undefined;
  const marshal = structured && isRecord(structured.marshal) ? structured.marshal : undefined;
  if (
    !structured ||
    !marshal ||
    marshal.kind !== "compiled_react_ui" ||
    typeof marshal.componentHtml !== "string" ||
    // Empty: the runtime omitted a component the renderer template already
    // mounted (a live-workspace poll); nothing to sandbox.
    marshal.componentHtml === ""
  ) {
    return output;
  }
  // Viewport gate for agent-authored components: the artifact declares the
  // viewports it serves on the payload marshal record (`viewports` member);
  // undeclared artifacts are desktop-only (common/runtime-ui-viewports.ts —
  // document markup is never a signal). A component that does not declare the
  // viewing client's viewport never mounts: an inert notice takes its place
  // and the embedder is told, so trusted chrome can offer the request-variant
  // path.
  let componentHtml = marshal.componentHtml;
  const props = isRecord(structured.props) ? structured.props : undefined;
  const served =
    parseUiViewports(marshal.viewports) ??
    parseUiViewports(props?.[AUTHORED_UI_VIEWPORTS_PROP]) ??
    DESKTOP_ONLY_VIEWPORTS;
  if (gate && !served.has(gate.viewport)) {
    gate.onMissing?.(gate.viewport);
    componentHtml =
      '<!doctype html><html><body><p style="font: 13px system-ui; opacity: 0.7; margin: 12px">' +
      `This component has no ${gate.viewport} view.` +
      "</p></body></html>";
  }
  const childNonce = crypto.randomUUID();
  registerChildNonce?.(childNonce);
  const sandboxed = createPackagedUiDocument(withHostTheme(componentHtml), childNonce);
  return {
    ...output,
    structuredContent: {
      ...structured,
      ...(gate && props
        ? { props: { ...props, [AUTHORED_UI_CLIENT_VIEWPORT_PROP]: gate.viewport } }
        : {}),
      marshal: { ...marshal, componentHtml: sandboxed.srcDoc },
    },
  };
}

const HOST_THEME_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ["--color-text-primary", "--foreground"],
  ["--color-background-primary", "--background"],
  ["--color-text-secondary", "--muted-foreground"],
  ["--color-background-secondary", "--muted"],
  ["--color-text-danger", "--destructive"],
  ["--color-border-primary", "--border"],
  ["--color-ring", "--ring"],
];
const SAFE_CSS_VALUE = /^[#\w\s(),.%/-]{1,200}$/;

/**
 * The runtime renderer template never applies host-context style variables,
 * so authored components always saw their light-theme fallbacks — dark text
 * on Marshal's dark background. Stamp the host's resolved theme tokens (the
 * standard MCP-Apps variable names the components already use) onto the
 * component document itself.
 */
function withHostTheme(componentHtml: string): string {
  const root = getComputedStyle(document.documentElement);
  const declarations = HOST_THEME_TOKENS.flatMap(([target, source]) => {
    const value = root.getPropertyValue(source).trim();
    return SAFE_CSS_VALUE.test(value) ? [`${target}:${value}`] : [];
  });
  const scheme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const themeTag = [
    "<style data-marshal-host-theme>:root{color-scheme:",
    scheme,
    ";",
    declarations.join(";"),
    "}</style>",
  ].join("");
  const head = /<head[^>]*>/i.exec(componentHtml);
  return head
    ? componentHtml.slice(0, head.index + head[0].length) +
        themeTag +
        componentHtml.slice(head.index + head[0].length)
    : themeTag + componentHtml;
}
