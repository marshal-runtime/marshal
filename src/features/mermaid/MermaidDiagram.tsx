import { createLogger } from "@common/marshal-logger";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SyntheticEvent } from "react";

import { Check, Code, Copy, Download, Eye, Maximize2, X } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/marshal-class-names";
import { useDocumentTheme } from "@/shared/hooks/useTheme";

import { diagramLabel } from "./diagram-graph";
import { DiagramViewport } from "./DiagramViewport";
import { downloadBlob, pngBlob, serializeDiagram, svgBlob } from "./export-diagram";
import { peekRenderedMermaid, renderMermaid } from "./render-mermaid";

const log = createLogger("MermaidDiagram");

export interface MermaidDiagramProps {
  source: string;
  /** True while the code fence is still streaming; rendering waits for the full source. */
  isIncomplete?: boolean;
  className?: string;
}

type Outcome = { key: string; svg: string } | { key: string; error: string };

function renderKey(source: string, theme: string): string {
  return `${theme}\u0000${source}`;
}

/**
 * The one Mermaid viewer for chat (Streamdown renderer) and the file preview:
 * themed from Marshal tokens, fit-to-width, pan/zoom, fullscreen, copy/export.
 */
export function MermaidDiagram({ source, isIncomplete = false, className }: MermaidDiagramProps) {
  const theme = useDocumentTheme();
  const key = renderKey(source, theme);
  const [outcome, setOutcome] = useState<Outcome | null>(() => {
    const cached = peekRenderedMermaid(source, theme);
    return cached ? { key, svg: cached.svg } : null;
  });
  const [showSource, setShowSource] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const svgElement = useRef<SVGSVGElement | null>(null);
  const empty = source.trim() === "";
  const settledKey = outcome?.key;

  useEffect(() => {
    if (isIncomplete || empty || settledKey === key) return undefined;
    let cancelled = false;
    renderMermaid(source, theme).then(
      ({ svg }) => {
        if (!cancelled) setOutcome({ key, svg });
      },
      (error: unknown) => {
        if (!cancelled) {
          setOutcome({ key, error: error instanceof Error ? error.message : String(error) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, theme, key, settledKey, isIncomplete, empty]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  // A stale diagram stays up while a theme or source change re-renders.
  const svg = outcome && "svg" in outcome ? outcome.svg : null;
  const error = outcome && outcome.key === key && "error" in outcome ? outcome.error : null;
  const label = diagramLabel(source);
  const pending = !empty && !error && (!svg || outcome?.key !== key);

  const rememberSvg = useCallback((element: SVGSVGElement | null) => {
    if (element) svgElement.current = element;
  }, []);

  const copySource = () => {
    void navigator.clipboard
      ?.writeText(source)
      .then(() => setCopied(true))
      .catch((copyError: unknown) => {
        log.warn("Copy diagram source failed", {
          error: copyError instanceof Error ? copyError.name : "unknown",
        });
      });
  };

  const exportAs = async (format: "svg" | "png") => {
    const element = svgElement.current;
    if (!element) return;
    try {
      const background = getComputedStyle(document.documentElement)
        .getPropertyValue("--card")
        .trim();
      const diagram = await serializeDiagram(element, background || "#ffffff");
      const blob = format === "svg" ? svgBlob(diagram) : await pngBlob(diagram);
      downloadBlob(blob, `${label.toLowerCase().replace(/\s+/g, "-")}.${format}`);
    } catch (exportError) {
      log.warn("Diagram export failed", {
        format,
        error: exportError instanceof Error ? exportError.name : "unknown",
      });
    }
  };

  const actions = (inFullscreen: boolean) => (
    <div className="flex items-center gap-0.5">
      {!inFullscreen && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-pressed={showSource}
          aria-label={showSource ? "Show diagram" : "View source"}
          title={showSource ? "Show diagram" : "View source"}
          data-mermaid-action="source"
          onClick={() => setShowSource((value) => !value)}
        >
          {showSource ? <Eye /> : <Code />}
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={copied ? "Copied" : "Copy source"}
        title={copied ? "Copied" : "Copy source"}
        data-mermaid-action="copy"
        onClick={copySource}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Download"
            title="Download"
            data-mermaid-action="download"
            disabled={!svg}
          >
            <Download />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void exportAs("svg")}>Download SVG</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void exportAs("png")}>Download PNG</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {inFullscreen ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close fullscreen"
          title="Close"
          onClick={() => setFullscreen(false)}
        >
          <X />
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Open fullscreen"
          title="Fullscreen"
          data-mermaid-action="fullscreen"
          disabled={!svg}
          onClick={() => setFullscreen(true)}
        >
          <Maximize2 />
        </Button>
      )}
    </div>
  );

  // Hosts may treat a click as "edit this block" (the file preview). Toolbar
  // buttons, zoom controls, and portaled UI (menu, fullscreen) bubble through
  // React's tree, so keep those clicks here; a plain click on the diagram passes.
  const containOwnControls = (event: SyntheticEvent<HTMLElement>) => {
    const target = event.target;
    const ownControl =
      target instanceof Element &&
      target.closest("button, [role='menuitem'], [data-marshal-mermaid='toolbar']");
    if (!(target instanceof Node) || !event.currentTarget.contains(target) || ownControl) {
      event.stopPropagation();
    }
  };

  return (
    <figure
      data-marshal-mermaid="frame"
      onClick={containOwnControls}
      onMouseDown={containOwnControls}
      onDoubleClick={containOwnControls}
      className={cn(
        "m-0 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xs",
        className,
      )}
    >
      <div
        data-marshal-mermaid="toolbar"
        className="flex h-10 items-center justify-between gap-2 border-b border-border bg-muted/40 pr-1.5 pl-3.5"
      >
        <figcaption className="truncate text-xs font-medium text-muted-foreground">
          {label}
        </figcaption>
        {actions(false)}
      </div>

      {showSource ? (
        <pre
          data-marshal-mermaid="source"
          className="m-0 max-h-[420px] overflow-auto p-4 font-mono text-xs/relaxed whitespace-pre text-foreground"
        >
          <code>{source}</code>
        </pre>
      ) : error ? (
        <div data-mermaid-error className="flex flex-col gap-3 p-4">
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
            <p className="m-0 text-sm font-medium">Couldn’t render this diagram</p>
            {/* Monospace without ligatures so the parser's ^ caret lines up. */}
            <pre className="m-0 mt-1 overflow-x-auto font-mono text-xs/relaxed whitespace-pre [font-variant-ligatures:none]">
              {error}
            </pre>
          </div>
          <pre className="m-0 max-h-[320px] overflow-auto rounded-lg border border-border bg-muted/50 px-4 py-3 font-mono text-xs/relaxed whitespace-pre text-foreground">
            <code>{source}</code>
          </pre>
        </div>
      ) : empty ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">Empty diagram</div>
      ) : svg ? (
        <div className={cn(pending && "opacity-70 transition-opacity")}>
          <DiagramViewport svg={svg} mode="inline" label={label} onSvgElement={rememberSvg} />
        </div>
      ) : (
        <div
          data-marshal-mermaid="pending"
          className="flex h-40 items-center justify-center text-sm text-muted-foreground"
        >
          <span className="animate-pulse">
            {isIncomplete ? "Drawing diagram…" : "Rendering diagram…"}
          </span>
        </div>
      )}

      {svg && (
        <Dialog open={fullscreen} onOpenChange={setFullscreen}>
          <DialogContent
            showCloseButton={false}
            data-marshal-mermaid="fullscreen"
            className="top-0 left-0 flex h-dvh w-screen max-w-none translate-none flex-col gap-0 rounded-none bg-card p-0 ring-0 sm:max-w-none"
          >
            <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border pr-2 pl-4">
              <DialogTitle className="truncate text-sm font-medium">{label}</DialogTitle>
              <DialogDescription className="sr-only">
                Drag to pan. Pinch or scroll to zoom.
              </DialogDescription>
              {actions(true)}
            </div>
            <DiagramViewport svg={svg} mode="fullscreen" label={label} onSvgElement={rememberSvg} />
          </DialogContent>
        </Dialog>
      )}
    </figure>
  );
}
