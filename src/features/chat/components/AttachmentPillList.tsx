import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { type FileAttachment } from "./ChatInput";
import { EntityPill } from "./EntityPill";

interface AttachmentPillListProps {
  files: FileAttachment[];
  onRemove: (index: number) => void;
}

const PILL_GAP = 8;

function pillKind(file: FileAttachment) {
  if (file.dataUrl) {
    return { type: "image", name: file.name, dataUrl: file.dataUrl } as const;
  }

  return {
    type: "file",
    name: file.name,
    extension: file.name.includes(".") ? file.name.split(".").pop() : undefined,
  } as const;
}

/**
 * Renders attachment pills with dynamic overflow based on available container width.
 * Uses a hidden measurement row + ResizeObserver to compute how many pills fit,
 * then shows a "+N" pill for the remainder.
 */
export function AttachmentPillList({ files, onRemove }: AttachmentPillListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const overflowMeasureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(files.length);

  const recalculate = useCallback(() => {
    const container = containerRef.current;
    const measureRow = measureRef.current;
    const overflowEl = overflowMeasureRef.current;
    if (!container || !measureRow || !overflowEl) return;

    const containerWidth = container.offsetWidth;
    const overflowWidth = overflowEl.offsetWidth;
    const pillEls = Array.from(measureRow.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    );
    let usedWidth = 0;
    let count = 0;

    for (let i = 0; i < pillEls.length; i++) {
      const pillWidth = pillEls[i].offsetWidth;
      const gapBefore = i > 0 ? PILL_GAP : 0;
      const isLast = i === pillEls.length - 1;
      // Reserve space for the overflow pill unless this is the final pill
      const spaceForOverflow = isLast ? 0 : PILL_GAP + overflowWidth;

      if (usedWidth + gapBefore + pillWidth + spaceForOverflow > containerWidth) break;

      usedWidth += gapBefore + pillWidth;
      count = i + 1;
    }

    setVisibleCount(Math.max(1, count));
  }, []);

  // Recalculate whenever files change (new/removed attachments).
  useLayoutEffect(() => {
    // Measuring DOM layout and syncing to state in useLayoutEffect is the
    // intended pattern here. The rule fires because recalculate calls
    // setVisibleCount indirectly, but there is no cascading risk.
    // eslint-disable-next-line react-compiler/set-state-in-effect
    recalculate();
  }, [files, recalculate]);

  // Recalculate whenever the container is resized (sidebar open/close, window resize)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const ro = new ResizeObserver(recalculate);
    ro.observe(container);
    return () => ro.disconnect();
  }, [recalculate]);

  if (files.length === 0) return null;

  const hiddenCount = files.length - visibleCount;

  return (
    <div ref={containerRef} data-testid="pill-list-container" className="relative">
      {/* Hidden measurement row — renders all pills off-screen to measure widths */}
      <div
        ref={measureRef}
        data-testid="measure-row"
        className="pointer-events-none absolute flex gap-2 opacity-0"
        aria-hidden="true"
      >
        {files.map((file) => (
          <EntityPill key={file.name} kind={pillKind(file)} size="md" onRemove={() => {}} />
        ))}
      </div>

      {/* Hidden overflow pill — measured so we know how much space to reserve */}
      <div
        ref={overflowMeasureRef}
        data-testid="measure-overflow"
        className="pointer-events-none absolute opacity-0"
        style={{ width: "fit-content" }}
        aria-hidden="true"
      >
        <div className="flex h-11 items-center rounded-2xl border border-border bg-card px-3 text-sm">
          +{files.length}
        </div>
      </div>

      {/* Visible row */}
      <div data-testid="visible-row" className="flex gap-2">
        {files.slice(0, visibleCount).map((file, i) => (
          <EntityPill
            key={file.name}
            kind={pillKind(file)}
            size="md"
            onRemove={() => onRemove(i)}
          />
        ))}
        {hiddenCount > 0 && (
          <div
            data-testid="overflow-pill"
            className="flex h-11 items-center rounded-2xl border border-border bg-card px-3 text-sm"
          >
            +{hiddenCount}
          </div>
        )}
      </div>
    </div>
  );
}
