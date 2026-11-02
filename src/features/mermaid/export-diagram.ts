import { createLogger } from "@common/marshal-logger";

const log = createLogger("MermaidExport");

// Largest PNG edge; keeps a 10k-px-tall flowchart within canvas memory limits.
const MAX_PNG_EDGE = 8192;

let fontCssPromise: Promise<string> | null = null;

/**
 * An exported SVG is drawn without the app's stylesheets, so Geist must travel
 * inside it or labels fall back to a wider system font and overflow the boxes
 * Mermaid sized for Geist. Best effort: export still works without it.
 */
function geistFontUrl(): URL | null {
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const family = rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim();
      if (family !== "Geist" || rule.style.getPropertyValue("font-style") === "italic") continue;
      const match = /url\(["']?([^"')]+)["']?\)/.exec(rule.style.getPropertyValue("src"));
      if (match) return new URL(match[1], sheet.href ?? document.baseURI);
    }
  }
  return null;
}

function embeddedFontCss(): Promise<string> {
  fontCssPromise ??= (async () => {
    const url = geistFontUrl();
    if (!url) return "";
    const response = await fetch(url);
    if (!response.ok) return "";
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return `@font-face{font-family:"Geist";font-weight:100 900;src:url(data:font/woff2;base64,${btoa(binary)}) format("woff2");}`;
  })().catch((error: unknown) => {
    log.warn("Could not embed Geist into the diagram export", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return "";
  });
  return fontCssPromise;
}

export interface SerializedDiagram {
  markup: string;
  width: number;
  height: number;
}

/** Standalone copy of a rendered diagram: hover state stripped, background and font inlined. */
export async function serializeDiagram(
  svg: SVGSVGElement,
  background: string,
): Promise<SerializedDiagram> {
  const clone = svg.cloneNode(true);
  if (!(clone instanceof SVGSVGElement)) throw new Error("Diagram clone is not an SVG element");
  clone.removeAttribute("data-mermaid-focus");
  for (const element of clone.querySelectorAll("[data-mermaid-active], [data-mermaid-hovered]")) {
    element.removeAttribute("data-mermaid-active");
    element.removeAttribute("data-mermaid-hovered");
  }
  const box = svg.viewBox.baseVal;
  const width = Math.ceil(box?.width || svg.getBoundingClientRect().width);
  const height = Math.ceil(box?.height || svg.getBoundingClientRect().height);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.removeAttribute("style");

  const backdrop = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  backdrop.setAttribute("x", String(box?.x ?? 0));
  backdrop.setAttribute("y", String(box?.y ?? 0));
  backdrop.setAttribute("width", "100%");
  backdrop.setAttribute("height", "100%");
  backdrop.setAttribute("fill", background);
  clone.insertBefore(backdrop, clone.firstChild);

  const fontCss = await embeddedFontCss();
  if (fontCss) {
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = fontCss;
    clone.insertBefore(style, clone.firstChild);
  }
  return { markup: new XMLSerializer().serializeToString(clone), width, height };
}

export function svgBlob(diagram: SerializedDiagram): Blob {
  return new Blob([diagram.markup], { type: "image/svg+xml;charset=utf-8" });
}

export async function pngBlob(diagram: SerializedDiagram): Promise<Blob> {
  const scale = Math.min(2, MAX_PNG_EDGE / Math.max(diagram.width, diagram.height));
  const image = new Image();
  image.decoding = "async";
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(diagram.markup)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(diagram.width * scale);
  canvas.height = Math.round(diagram.height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is not available");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))),
      "image/png",
    );
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
