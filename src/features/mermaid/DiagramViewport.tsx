import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import { ChevronDown, ChevronUp, Minus, Plus, RotateCcw } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { cn } from "@/lib/marshal-class-names";

import { buildHoverGraph } from "./diagram-graph";
import {
  clampScale,
  clampView,
  fitWidthScale,
  fitWidthView,
  MAX_SCALE,
  minScale,
  pinchView,
  zoomAt,
} from "./pan-zoom";
import type { Point, Size, View } from "./pan-zoom";

const INLINE_PAD = 16;
const FULLSCREEN_PAD = 24;
const ZOOM_STEP = 1.25;
// Inline diagrams taller than this collapse behind an expand affordance.
const INLINE_MAX_HEIGHT = 560;

interface DiagramViewportProps {
  svg: string;
  mode: "inline" | "fullscreen";
  label: string;
  onSvgElement?: (svg: SVGSVGElement | null) => void;
}

function readNaturalSize(svg: SVGSVGElement): Size | null {
  const box = svg.viewBox?.baseVal;
  if (box && box.width > 0 && box.height > 0) return { width: box.width, height: box.height };
  const attribute = svg.getAttribute("viewBox") ?? svg.getAttribute("viewbox") ?? "";
  const parts = attribute
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
    return { width: parts[2], height: parts[3] };
  }
  return null;
}

function elementOf(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

function inlineMaxHeight(): number {
  if (typeof window === "undefined") return INLINE_MAX_HEIGHT;
  return Math.round(Math.min(INLINE_MAX_HEIGHT, Math.max(320, window.innerHeight * 0.65)));
}

export function DiagramViewport({ svg, mode, label, onSvgElement }: DiagramViewportProps) {
  const fullscreen = mode === "fullscreen";
  const pad = fullscreen ? FULLSCREEN_PAD : INLINE_PAD;
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [view, setView] = useState<View | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ view: View; points: Point[]; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const graph = useRef<Map<Element, Element[]>>(new Map());
  const hovered = useRef<Element | null>(null);

  // Mermaid emits width="100%" plus a max-width style. Inside a shrink-to-fit
  // flex parent that resolves to Chrome's 300px replaced-element default, which
  // is what shrank chat diagrams to illegible text. Pin the SVG to its natural
  // size and let the stage transform do all scaling.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // Set imperatively: a dangerouslySetInnerHTML prop would let React rewrite
    // the markup on re-render and undo the sizing below. Mermaid already
    // sanitizes with DOMPurify under securityLevel "strict" (our config);
    // sanitizing again strips its foreignObject labels.
    stage.innerHTML = svg;
    const element = stage.querySelector("svg");
    if (!element) {
      setNatural(null);
      onSvgElement?.(null);
      return;
    }
    const size = readNaturalSize(element);
    if (size) {
      element.setAttribute("width", String(size.width));
      element.setAttribute("height", String(size.height));
      element.style.maxWidth = "none";
      element.style.display = "block";
    }
    graph.current = buildHoverGraph(element);
    hovered.current = null;
    setNatural(size);
    onSvgElement?.(element);
  }, [svg, onSvgElement]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const measure = () => {
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      setBox((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const fitScale = natural ? fitWidthScale(natural, box.width, pad) : 1;
  const fullHeight = natural ? Math.ceil(natural.height * fitScale + pad * 2) : 160;
  const cap = inlineMaxHeight();
  const capped = !fullscreen && fullHeight > cap + 24;
  const inlineHeight = capped && !expanded ? cap : fullHeight;
  const viewportSize = useMemo<Size>(
    () => ({ width: box.width, height: fullscreen ? box.height : inlineHeight }),
    [box.width, box.height, fullscreen, inlineHeight],
  );
  const lowestScale = natural ? minScale(natural, viewportSize, pad) : 1;

  // `view` stays null until the user pans or zooms, so the diagram keeps
  // tracking the default fit through resizes (sidebar toggles, rotation, expand).
  const ready = natural !== null && viewportSize.width > 0;
  const current: View | null = !ready
    ? null
    : view
      ? clampView(view, natural, viewportSize, pad)
      : fitWidthView(natural, viewportSize, pad);

  const commit = useCallback(
    (next: View) => {
      if (!natural) return;
      setView(clampView(next, natural, viewportSize, pad));
    },
    [natural, viewportSize, pad],
  );

  const reset = useCallback(() => setView(null), []);

  const zoomBy = useCallback(
    (factor: number, anchor?: Point) => {
      if (!current) return;
      const point = anchor ?? { x: viewportSize.width / 2, y: viewportSize.height / 2 };
      commit(zoomAt(current, clampScale(current.scale * factor, lowestScale), point));
    },
    [current, viewportSize, lowestScale, commit],
  );

  const onWheel = useEffectEvent((event: WheelEvent) => {
    if (!current || !viewportRef.current) return;
    const zoomGesture = event.ctrlKey || event.metaKey;
    // Inline, a plain wheel keeps scrolling the chat; zoom needs pinch or Ctrl/⌘.
    if (!zoomGesture && !fullscreen) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportSize.height : 1;
    if (zoomGesture) {
      const rect = viewportRef.current.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * unit * 0.0025);
      zoomBy(factor, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    } else {
      commit({
        ...current,
        x: current.x - event.deltaX * unit,
        y: current.y - event.deltaY * unit,
      });
    }
  });

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const listener = (event: WheelEvent) => onWheel(event);
    viewport.addEventListener("wheel", listener, { passive: false });
    return () => viewport.removeEventListener("wheel", listener);
  }, []);

  const localPoint = (event: ReactPointerEvent): Point => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const restartGesture = () => {
    gesture.current = current
      ? { view: current, points: [...pointers.current.values()], moved: false }
      : null;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (elementOf(event.target)?.closest("button, a")) return;
    // Touch has no hover; a tap selects the node (and a tap on empty space clears it).
    if (event.pointerType !== "mouse") updateHover(elementOf(event.target));
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, localPoint(event));
    restartGesture();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) {
      updateHover(elementOf(event.target));
      return;
    }
    pointers.current.set(event.pointerId, localPoint(event));
    const start = gesture.current;
    if (!start) return;
    const points = [...pointers.current.values()];
    if (points.length >= 2 && start.points.length >= 2) {
      start.moved = true;
      setDragging(true);
      commit(
        pinchView(start.view, [start.points[0], start.points[1]], [points[0], points[1]], {
          min: lowestScale,
          max: MAX_SCALE,
        }),
      );
      return;
    }
    const dx = points[0].x - start.points[0].x;
    const dy = points[0].y - start.points[0].y;
    if (!start.moved && Math.hypot(dx, dy) < 3) return;
    start.moved = true;
    setDragging(true);
    commit({ ...start.view, x: start.view.x + dx, y: start.view.y + dy });
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    if (gesture.current?.moved) suppressClick.current = true;
    if (pointers.current.size === 0) {
      gesture.current = null;
      setDragging(false);
    } else {
      restartGesture();
    }
  };

  const updateHover = (target: Element | null) => {
    const svgElement = stageRef.current?.querySelector("svg");
    if (!svgElement || gesture.current?.moved) return;
    const node = target?.closest("g.node") ?? null;
    const next = node && graph.current.has(node) ? node : null;
    if (next === hovered.current) return;
    for (const element of svgElement.querySelectorAll("[data-mermaid-active]")) {
      element.removeAttribute("data-mermaid-active");
    }
    hovered.current?.removeAttribute("data-mermaid-hovered");
    hovered.current = next;
    if (!next) {
      svgElement.removeAttribute("data-mermaid-focus");
      return;
    }
    svgElement.setAttribute("data-mermaid-focus", "");
    next.setAttribute("data-mermaid-hovered", "");
    for (const element of graph.current.get(next) ?? []) {
      element.setAttribute("data-mermaid-active", "");
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!current) return;
    const step = 48;
    const keys: Record<string, () => void> = {
      "+": () => zoomBy(ZOOM_STEP),
      "=": () => zoomBy(ZOOM_STEP),
      "-": () => zoomBy(1 / ZOOM_STEP),
      "0": reset,
      ArrowLeft: () => commit({ ...current, x: current.x + step }),
      ArrowRight: () => commit({ ...current, x: current.x - step }),
      ArrowUp: () => commit({ ...current, y: current.y + step }),
      ArrowDown: () => commit({ ...current, y: current.y - step }),
    };
    const action = keys[event.key];
    if (!action || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    action();
  };

  const zoomedIn = current ? current.scale > fitScale + 0.001 : false;
  const pannable =
    !!current &&
    !!natural &&
    (natural.width * current.scale > viewportSize.width + 1 ||
      natural.height * current.scale > viewportSize.height + 1);
  const percent = current ? Math.round(current.scale * 100) : 100;

  return (
    <div className={cn("group/diagram relative", fullscreen && "flex min-h-0 flex-1 flex-col")}>
      <div
        ref={viewportRef}
        data-marshal-mermaid="viewport"
        role="img"
        aria-label={`${label}. Drag to pan; pinch, Ctrl or ⌘ + scroll, or plus and minus keys to zoom; 0 resets.`}
        tabIndex={0}
        className={cn(
          "relative overflow-hidden outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
          fullscreen ? "min-h-0 flex-1" : "transition-[height] duration-200 ease-out",
          pannable ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-default",
        )}
        style={{
          height: fullscreen ? undefined : inlineHeight,
          touchAction: fullscreen || zoomedIn ? "none" : "pan-y",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onPointerLeave={(event) => {
          if (!pointers.current.has(event.pointerId)) updateHover(null);
        }}
        onClickCapture={(event) => {
          // A pan or pinch ends in a click; don't let it reach hosts that treat
          // a click as "edit this block" (the file preview).
          if (suppressClick.current) {
            suppressClick.current = false;
            event.stopPropagation();
          }
        }}
        onKeyDown={onKeyDown}
      >
        <div
          ref={stageRef}
          data-marshal-mermaid="stage"
          className="absolute top-0 left-0 origin-top-left"
          style={{
            transform: current
              ? `translate(${current.x}px, ${current.y}px) scale(${current.scale})`
              : undefined,
            visibility: current ? "visible" : "hidden",
          }}
        />

        {capped && !expanded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-24 items-end justify-center bg-linear-to-b from-transparent to-card pb-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-mermaid-expand
              className="pointer-events-auto rounded-full bg-card shadow-sm"
              onClick={() => {
                setExpanded(true);
                reset();
              }}
            >
              <ChevronDown />
              Show full diagram
            </Button>
          </div>
        )}

        <div
          data-marshal-mermaid="zoom-controls"
          className={cn(
            "absolute right-2 flex items-center gap-0.5 rounded-lg border border-border bg-card/90 p-0.5 shadow-sm backdrop-blur-sm",
            capped && !expanded ? "top-2" : "bottom-2",
            // Inline, the controls would sit on the diagram: show them on hover
            // or keyboard focus; touch-only screens pinch or go fullscreen.
            !fullscreen &&
              "opacity-0 transition-opacity group-focus-within/diagram:opacity-100 group-hover/diagram:opacity-100 pointer-coarse:hidden",
          )}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom out"
            title="Zoom out"
            disabled={!current || current.scale <= lowestScale + 0.001}
            onClick={() => zoomBy(1 / ZOOM_STEP)}
          >
            <Minus />
          </Button>
          <span
            className="min-w-10 text-center font-mono text-[11px] text-muted-foreground tabular-nums"
            aria-live="polite"
          >
            {percent}%
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom in"
            title="Zoom in"
            disabled={!current || current.scale >= MAX_SCALE - 0.001}
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            <Plus />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Fit to width"
            title="Fit to width"
            onClick={reset}
          >
            <RotateCcw />
          </Button>
        </div>
      </div>

      {capped && expanded && (
        <div className="flex justify-center border-t border-border py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => {
              setExpanded(false);
              reset();
            }}
          >
            <ChevronUp />
            Collapse
          </Button>
        </div>
      )}
    </div>
  );
}
