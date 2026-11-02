import type { MermaidConfig } from "mermaid";

export interface MermaidPalette {
  canvas: string;
  ink: string;
  muted: string;
  node: string;
  nodeBorder: string;
  accent: string;
  secondary: string;
  secondaryBorder: string;
  tertiary: string;
  cluster: string;
  clusterBorder: string;
  chart: [string, string, string, string, string];
}

// Mirrors the light/dark tokens in src/index.css; used only when the
// variables cannot be read (tests, SSR) or hold a value Mermaid can't parse.
const FALLBACK_PALETTES: Record<"light" | "dark", MermaidPalette> = {
  light: {
    canvas: "hsl(0, 0%, 100%)",
    ink: "hsl(240, 10%, 9%)",
    muted: "hsl(240, 10%, 42%)",
    node: "hsl(250, 90%, 96%)",
    nodeBorder: "hsl(250, 72%, 88%)",
    accent: "hsl(250, 66%, 52%)",
    secondary: "hsl(240, 24%, 94%)",
    secondaryBorder: "hsl(240, 18%, 90%)",
    tertiary: "hsl(240, 26%, 92%)",
    cluster: "hsl(240, 24%, 94%)",
    clusterBorder: "hsl(240, 18%, 90%)",
    chart: [
      "hsl(250, 66%, 52%)",
      "hsl(162, 78%, 30%)",
      "hsl(28, 88%, 45%)",
      "hsl(199, 89%, 42%)",
      "hsl(240, 5%, 45%)",
    ],
  },
  dark: {
    canvas: "hsl(240, 9%, 11%)",
    ink: "hsl(240, 14%, 92%)",
    muted: "hsl(240, 5%, 58%)",
    node: "hsl(250, 38%, 22%)",
    nodeBorder: "hsl(250, 40%, 40%)",
    accent: "hsl(252, 92%, 76%)",
    secondary: "hsl(240, 8%, 14%)",
    secondaryBorder: "hsl(240, 6%, 22%)",
    tertiary: "hsl(240, 8%, 16%)",
    cluster: "hsl(240, 8%, 14%)",
    clusterBorder: "hsl(240, 6%, 22%)",
    chart: [
      "hsl(252, 92%, 76%)",
      "hsl(162, 60%, 45%)",
      "hsl(32, 95%, 65%)",
      "hsl(199, 89%, 62%)",
      "hsl(240, 5%, 58%)",
    ],
  },
};

const PARSEABLE_COLOR = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i;

/** Reads the diagram palette from Marshal's CSS variables for the active theme. */
export function readMermaidPalette(theme: "light" | "dark"): MermaidPalette {
  const fallback = FALLBACK_PALETTES[theme];
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return fallback;
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, backup: string) => {
    const value = style.getPropertyValue(name).trim();
    return PARSEABLE_COLOR.test(value) ? value : backup;
  };
  return {
    canvas: read("--card", fallback.canvas),
    ink: read("--foreground", fallback.ink),
    muted: read("--muted-foreground", fallback.muted),
    node: read("--brand-subtle", fallback.node),
    nodeBorder: read("--brand-border", fallback.nodeBorder),
    accent: read("--brand-stroke", fallback.accent),
    secondary: read("--secondary", fallback.secondary),
    secondaryBorder: read("--input", fallback.secondaryBorder),
    tertiary: read("--accent", fallback.tertiary),
    cluster: read("--muted", fallback.cluster),
    clusterBorder: read("--border", fallback.clusterBorder),
    chart: [
      read("--chart-1", fallback.chart[0]),
      read("--chart-2", fallback.chart[1]),
      read("--chart-3", fallback.chart[2]),
      read("--chart-4", fallback.chart[3]),
      read("--chart-5", fallback.chart[4]),
    ],
  };
}

export const MERMAID_FONT_FAMILY =
  'Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

// Typography lives inside the SVG's own <style> so Mermaid measures labels and
// the browser paints them under identical rules. Without it, the host's
// line-height / word-break (e.g. chat's leading-[1.7]) leaks into
// foreignObject labels after measurement and pushes text past its box.
const THEME_CSS = `
  .label, .nodeLabel, .edgeLabel, .cluster-label, foreignObject div, foreignObject span, foreignObject p {
    line-height: 1.5; letter-spacing: normal; word-break: normal; overflow-wrap: normal;
    font-family: ${MERMAID_FONT_FAMILY};
  }
  .node rect, .node polygon, .node circle, .node ellipse, .node path { stroke-width: 1.25px; }
  .node rect, .cluster rect { rx: 10px; ry: 10px; }
  .nodeLabel, .cluster-label { font-weight: 500; }
  .edgeLabel, .edgeLabel p { font-size: 12px; }
  .edgeLabel rect, .labelBkg { rx: 6px; ry: 6px; }
  .flowchart-link, .edgePath .path { stroke-width: 1.5px; stroke-linecap: round; stroke-linejoin: round; }
  .actor { rx: 10px; ry: 10px; }
  .note { rx: 8px; ry: 8px; }
`;

/** One Mermaid config for chat, Markdown files, and exported images. */
export function getMermaidConfig(
  theme: "light" | "dark",
  palette: MermaidPalette = readMermaidPalette(theme),
): MermaidConfig {
  const dark = theme === "dark";
  const { canvas, ink, muted, node, nodeBorder, accent, chart } = palette;
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: "base",
    look: "classic",
    fontFamily: MERMAID_FONT_FAMILY,
    themeVariables: {
      darkMode: dark,
      background: canvas,
      fontFamily: MERMAID_FONT_FAMILY,
      fontSize: "14px",
      primaryColor: node,
      primaryTextColor: ink,
      primaryBorderColor: nodeBorder,
      secondaryColor: palette.secondary,
      secondaryTextColor: ink,
      secondaryBorderColor: palette.secondaryBorder,
      tertiaryColor: palette.tertiary,
      tertiaryTextColor: ink,
      tertiaryBorderColor: palette.secondaryBorder,
      lineColor: muted,
      textColor: ink,
      mainBkg: node,
      nodeBorder,
      nodeTextColor: ink,
      clusterBkg: palette.cluster,
      clusterBorder: palette.clusterBorder,
      titleColor: ink,
      edgeLabelBackground: canvas,
      actorBkg: node,
      actorBorder: nodeBorder,
      actorTextColor: ink,
      actorLineColor: nodeBorder,
      signalColor: muted,
      signalTextColor: ink,
      labelBoxBkgColor: node,
      labelBoxBorderColor: nodeBorder,
      labelTextColor: ink,
      loopTextColor: ink,
      noteBkgColor: palette.secondary,
      noteBorderColor: palette.secondaryBorder,
      noteTextColor: ink,
      activationBkgColor: palette.tertiary,
      activationBorderColor: accent,
      sequenceNumberColor: canvas,
      pie1: chart[0],
      pie2: chart[1],
      pie3: chart[2],
      pie4: chart[3],
      pie5: chart[4],
      git0: chart[0],
      git1: chart[1],
      git2: chart[2],
      git3: chart[3],
    },
    flowchart: { curve: "basis", nodeSpacing: 40, rankSpacing: 56, padding: 18 },
    sequence: { actorMargin: 48, diagramMarginX: 24, diagramMarginY: 24, noteMargin: 12 },
    themeCSS: THEME_CSS,
  };
}
