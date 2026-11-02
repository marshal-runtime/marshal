import type { Mermaid } from "mermaid";

import { getMermaidConfig, readMermaidPalette } from "@/runtime-ui/theme/mermaid-theme";

let mermaidPromise: Promise<Mermaid> | null = null;
let configKey: string | null = null;
// Monotonic ids: Mermaid creates and removes temp DOM nodes keyed by the id,
// and reusing one across mounts silently breaks sequence diagrams.
let renderCounter = 0;

function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid").then((module) => module.default);
  return mermaidPromise;
}

// Labels are sized from text measured at render time. Measuring before Geist
// has loaded sizes boxes for the fallback font, and the real glyphs then
// overflow them. Bounded so a missing font never blocks the diagram.
async function fontsReady(): Promise<void> {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts?.load) return;
  const loaded = Promise.all([fonts.load("400 14px Geist"), fonts.load("500 14px Geist")]).then(
    () => fonts.ready,
  );
  await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 1500))]).catch(
    () => undefined,
  );
}

export interface RenderedDiagram {
  svg: string;
}

// Chat remounts message blocks as it virtualizes and re-parses; caching by
// source + theme lets a remount paint the finished diagram immediately.
const CACHE_LIMIT = 40;
const cache = new Map<string, RenderedDiagram>();

function cacheKey(source: string, theme: "light" | "dark"): string {
  return `${theme}\u0000${source}`;
}

export function peekRenderedMermaid(
  source: string,
  theme: "light" | "dark",
): RenderedDiagram | undefined {
  return cache.get(cacheKey(source, theme));
}

export function renderMermaid(source: string, theme: "light" | "dark"): Promise<RenderedDiagram> {
  const key = cacheKey(source, theme);
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  return (async () => {
    const [mermaid] = await Promise.all([loadMermaid(), fontsReady()]);
    const palette = readMermaidPalette(theme);
    const paletteKey = `${theme}:${JSON.stringify(palette)}`;
    // initialize() and render() run back to back with no await between them;
    // Mermaid queues renders internally and its config is global.
    if (paletteKey !== configKey) {
      mermaid.initialize(getMermaidConfig(theme, palette));
      configKey = paletteKey;
    }
    const { svg } = await mermaid.render(`marshal-mermaid-${++renderCounter}`, source);
    const rendered = { svg };
    cache.set(key, rendered);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value ?? "");
    return rendered;
  })();
}
