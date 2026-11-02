declare global {
  interface Window {
    __customContextMenuActive?: boolean;
  }
}

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ChevronRight, GripVertical } from "@/components/icons";
import { ShortcutKbd } from "@/features/hotkeys";
import { useWorkspaceDocument } from "@/features/runtime-ui/WorkspaceDocumentScope";
import { useUndoStack } from "@/runtime-ui/hooks/use-undo-stack";
import { useDocumentTheme } from "@/shared/hooks/useTheme";

import type { RuntimeUiDocumentAnnotation } from "../../../common/runtime-ui";
import type { SlashCommandItem } from "./filepreview/commands/command-catalog";
import { SlashCommandPicker } from "./filepreview/commands/SlashCommandPicker";
import { parseInlineRich } from "./filepreview/inlineMarkdown";
import {
  COMMENT_END_RE,
  COMMENT_START_RE,
  parseSegments,
  type Segment,
} from "./filepreview/markdownParser";
import { type AnnotatedEditor, useMonacoAnnotations } from "./filepreview/monacoAnnotations";
import { monacoLanguageForFile } from "./filepreview/monacoLanguage";
import { appendQueryParam, buildLocalPreviewUrl } from "./filepreview/preview-support/previewUrls";
import { RenderedComment, renderSegmentContent } from "./filepreview/rendering/segment-renderer";
import { SearchBar } from "./filepreview/SearchBar";
import { detectPartialSelection } from "./filepreview/selection-support/detectPartialSelection";
import { type MarkdownRange } from "./filepreview/selection-support/rangeToMarkdownRange";
import { tryHandlePartialSelectionKey } from "./filepreview/selection-support/tryHandlePartialSelectionKey";
import { useMountedRef } from "./filepreview/selection-support/useMountedRef";
import { useFileSearch } from "./filepreview/state/useFileSearch";
import { useSegmentSelection } from "./filepreview/state/useSegmentSelection";
import { useSlashCommand } from "./filepreview/state/useSlashCommand";
import { useComments } from "./filepreview/useComments";
import { useSegmentEditor } from "./filepreview/useSegmentEditor";
import { ZOOM_EPSILON } from "./hooks/state/useZoom";
import { useCreateContextMenu } from "./hooks/useCreateContextMenu";
import { InteractiveTable } from "./InteractiveTable";

// Referenced by E2E afterEach guards that must wait for the save to drain.
export const SAVE_DEBOUNCE_MS = 800;

// Lazy-load Monaco editor (keeps ~4MB bundle in a separate chunk)
const MonacoEditor = lazy(() =>
  import("./filepreview/MonacoEditor").then((m) => ({ default: m.MonacoEditor })),
);

// ── Types ──────────────────────────────────────────────────────
interface FilePreviewProps {
  filePath: string;
  readCapability?: string;
  /** Called when the file cannot be read (e.g. deleted on disk). */
  onError?: () => void;
  /**
   * Visual zoom multiplier (1 = 100%) applied to the rendered content area.
   * Only takes effect for non-Monaco surfaces (markdown preview, HTML preview,
   * image preview). Monaco source/text views ignore this — they have their own
   * Ctrl+= zoom controls and don't play well with CSS `zoom` overlays.
   */
  zoom?: number;
  /** 1-based line to scroll to once the Monaco view is showing. */
  revealLine?: number;
  /** Extension-supplied line marks rendered in the Monaco view. */
  annotations?: readonly RuntimeUiDocumentAnnotation[];
}

interface FileContent {
  type: "markdown" | "text" | "image" | "html";
  content: string;
}

// ── Constants ──────────────────────────────────────────────────
const PROGRESSIVE_INITIAL = 80;
const PROGRESSIVE_BATCH = 80;
const TASK_RE = /^(\s*[-*+]\s)\[( |x|X)\]\s/;

// ── Main Component ────────────────────────────────────────────
export function FilePreview({
  filePath,
  readCapability,
  onError,
  zoom = 1,
  revealLine,
  annotations,
}: FilePreviewProps) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentPath, setCurrentPath] = useState(filePath);
  const theme = useDocumentTheme();
  const lastSavedRef = useRef("");
  const undoStack = useUndoStack("");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingSaveRef = useRef<{ path: string; value: string } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const mountedRef = useMountedRef();
  const [renderBudget, setRenderBudget] = useState(PROGRESSIVE_INITIAL);

  // Flush pending debounced save on file switch or unmount
  useEffect(() => {
    return () => {
      clearTimeout(saveTimerRef.current);
      const pending = pendingSaveRef.current;
      if (pending && pending.value !== lastSavedRef.current) {
        lastSavedRef.current = pending.value;
        void window.workspaceAPI?.writeFile(pending.path, pending.value);
      }
      pendingSaveRef.current = null;
    };
  }, [filePath]);

  if (filePath !== currentPath) {
    setCurrentPath(filePath);
    setLoading(true);
    setError(null);
    setContent(null);
  }

  // File I/O
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result =
        readCapability === undefined
          ? await window.workspaceAPI?.readFile(filePath)
          : await window.workspaceAPI?.readFile(filePath, readCapability);
      if (cancelled) return;
      setLoading(false);
      if (!result?.success) {
        setError(result?.error ?? "Failed to read file");
        onError?.();
        return;
      }
      const raw = result.content ?? "";
      // Normalize CRLF/CR → LF so markdown regex matching works correctly.
      // Files edited here will be saved as LF — this is intentional, matching
      // standard editor behavior (VS Code, Notepad++, etc.).
      const c = raw.replace(/\r\n?/g, "\n");
      lastSavedRef.current = c;
      undoStack.reset(c);
      setContent({ type: result.type ?? "text", content: c });
      setRenderBudget(PROGRESSIVE_INITIAL);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-compiler/exhaustive-deps -- undoStack mutates per push
  }, [filePath, readCapability]);

  // Live-reload on external changes
  useEffect(() => {
    const unsub = window.workspaceAPI?.onWorkspaceChange(() => {
      void (async () => {
        const result =
          readCapability === undefined
            ? await window.workspaceAPI?.readFile(filePath)
            : await window.workspaceAPI?.readFile(filePath, readCapability);
        if (!result?.success) return;
        const raw = result.content ?? "";
        const c = raw.replace(/\r\n?/g, "\n");
        if (c !== lastSavedRef.current) {
          lastSavedRef.current = c;
          undoStack.reset(c);
          setContent({ type: result.type ?? "text", content: c });
          setRenderBudget(PROGRESSIVE_INITIAL);
        }
      })();
    });
    return () => {
      unsub?.();
    };
    // eslint-disable-next-line react-compiler/exhaustive-deps -- undoStack mutates per push
  }, [filePath, readCapability]);

  const applyContent = useCallback((value: string) => {
    setContent((prev) => (prev ? { ...prev, content: value } : prev));
  }, []);

  const debouncedSave = useCallback(
    (value: string) => {
      clearTimeout(saveTimerRef.current);
      pendingSaveRef.current = { path: filePath, value };
      saveTimerRef.current = setTimeout(() => {
        if (value !== lastSavedRef.current) {
          lastSavedRef.current = value;
          void window.workspaceAPI?.writeFile(filePath, value);
        }
        pendingSaveRef.current = null;
      }, SAVE_DEBOUNCE_MS);
    },
    [filePath],
  );

  const lines = useMemo(() => (content?.content ?? "").split("\n"), [content?.content]);
  const segments = useMemo(() => parseSegments(lines), [lines]);

  // ── Hooks ─────────────────────────────────────────────────────
  const contentMutators = useMemo(
    () => ({
      undoStackPush: undoStack.push,
      applyContent,
      debouncedSave,
    }),
    [undoStack.push, applyContent, debouncedSave],
  );

  const { getSelectedSegRange, clearSelection, getSelectionMarkdown } = useSegmentSelection({
    editorRef,
    segments,
    lines,
  });

  const {
    activeSegIdx,
    setActiveSegIdx,
    editValue,
    setEditValue,
    editUndo,
    editUndoHandledRef,
    lockedHeight,
    clearHeightLock,
    pendingActivateLineRef,
    pendingCursorPosRef,
    queuePendingEditAction,
    dragAnchorSegRef,
    activateSegment,
    commitEdit,
    handleInputKeyDown,
    handleTextareaKeyDown,
    handleSegMouseDown,
    handleSegClick,
    handleBlur,
    handlePaste,
    handleCopy,
  } = useSegmentEditor({
    segments,
    lines,
    inputRef,
    editorRef,
    content: contentMutators,
    getSelectionMarkdown,
  });

  // ── Partial-edit dispatch helpers ─────────────────────────────
  // Centralizes the "set pendingEditAction → clear selection → activate
  // segment" pattern used by keyboard and context-menu handlers.

  const dispatchPartialEdit = useCallback(
    (mdRange: MarkdownRange, replaceWith: string, segIdx: number) => {
      queuePendingEditAction({
        mdStart: mdRange.mdStart,
        mdEnd: mdRange.mdEnd,
        replaceWith,
      });
      clearSelection();
      activateSegment(segIdx);
    },
    [queuePendingEditAction, clearSelection, activateSegment],
  );

  const dispatchPartialEditFromClipboard = useCallback(
    async (mdRange: MarkdownRange, segIdx: number) => {
      const clipText = await navigator.clipboard.readText().catch(() => null as string | null);
      if (!clipText || !mountedRef.current) return;
      dispatchPartialEdit(mdRange, clipText, segIdx);
    },
    [dispatchPartialEdit, mountedRef],
  );

  const {
    pendingCommentEdit,
    commentEditCounter,
    addComment,
    resolveComment,
    replyToComment,
    updateComment,
  } = useComments({
    activeSegIdx,
    commitEdit,
    setActiveSegIdx,
    clearHeightLock,
    segments,
    lines,
    content: contentMutators,
  });

  // ── Slash command menu ───────────────────────────────────────
  const slashSelectRef = useRef<(item: SlashCommandItem) => void>(() => {});
  const slashCmd = useSlashCommand(activeSegIdx, (item) => slashSelectRef.current(item));
  const [slashAnchorEl, setSlashAnchorEl] = useState<HTMLElement | null>(null);

  // Source mode (declared early so useFileSearch can reference it)
  const hasLineTargets = Boolean(annotations?.length) || revealLine !== undefined;
  const [sourceMode, setSourceMode] = useState(hasLineTargets);
  const [hadLineTargets, setHadLineTargets] = useState(hasLineTargets);
  if (hasLineTargets !== hadLineTargets) {
    setHadLineTargets(hasLineTargets);
    if (hasLineTargets) setSourceMode(true);
  }
  const [annotatedEditor, setAnnotatedEditor] = useState<AnnotatedEditor | null>(null);
  const captureEditor = useCallback((editor: AnnotatedEditor) => {
    setAnnotatedEditor(editor);
    editor.onDidDispose(() =>
      setAnnotatedEditor((current) => (current === editor ? null : current)),
    );
  }, []);
  useMonacoAnnotations(annotatedEditor, annotations, revealLine);
  useWorkspaceDocument(annotatedEditor, filePath);

  // ── Scroll position sync across Preview / Source toggle ──────────────
  // Stores the *content* anchor (a 1-indexed source line) so that switching
  // sides lands the user at roughly the same spot in the document, regardless
  // of which side they scrolled on. Markdown always parses into segments, so
  // this line-based anchor is the single source of truth.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const monacoEditorRef = useRef<{
    getScrollTop(): number;
    setScrollTop(newScrollTop: number): void;
    getTopForLineNumber(lineNumber: number): number;
    getVisibleRanges(): { startLineNumber: number; endLineNumber: number }[];
  } | null>(null);
  // 1-indexed source line representing the topmost content visible on whichever
  // side the user last scrolled.
  const sharedAnchorLineRef = useRef(1);
  // Map of segment index -> rendered DOM element. Populated via callback ref on
  // each segment; avoids coupling scroll-sync to the data-testid attribute.
  const segmentElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  // Mirror `segments` into a ref so the capture/apply callbacks stay stable
  // across markdown edits and don't re-fire the restore effect on every render.
  const segmentsRef = useRef(segments);
  useLayoutEffect(() => {
    segmentsRef.current = segments;
  });

  // Reset the anchor when the user opens a different file so the new file
  // starts at the top instead of inheriting the previous file's scroll.
  useEffect(() => {
    sharedAnchorLineRef.current = 1;
  }, [filePath]);

  const captureFromPreview = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const segs = segmentsRef.current;
    const containerTop = container.getBoundingClientRect().top;
    // Walk segments in index order (top to bottom) and pick the first one whose
    // bottom edge lies below the container's top edge.
    const entries = Array.from(segmentElsRef.current.entries()).sort((a, b) => a[0] - b[0]);
    for (const [segIdx, el] of entries) {
      const r = el.getBoundingClientRect();
      if (r.bottom <= containerTop) continue;
      const seg = segs[segIdx];
      if (!seg) break;
      const segHeight = Math.max(1, r.height);
      const visibleOffset = Math.max(0, containerTop - r.top);
      const frac = Math.min(1, visibleOffset / segHeight);
      const span = seg.end - seg.start + 1;
      sharedAnchorLineRef.current = seg.start + 1 + Math.floor(frac * span);
      return;
    }
    sharedAnchorLineRef.current = 1;
  }, []);

  const captureFromSource = useCallback(() => {
    const editor = monacoEditorRef.current;
    if (!editor) return;
    const visible = editor.getVisibleRanges();
    sharedAnchorLineRef.current = visible[0]?.startLineNumber ?? 1;
  }, []);

  const applyToPreview = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const segs = segmentsRef.current;
    if (segs.length === 0) return;
    const lineIdx = sharedAnchorLineRef.current - 1;
    let segIdx = segs.findIndex((s) => s.start <= lineIdx && s.end >= lineIdx);
    if (segIdx < 0) segIdx = segs.findIndex((s) => s.start >= lineIdx);
    if (segIdx < 0) {
      container.scrollTop = container.scrollHeight;
      return;
    }
    const el = segmentElsRef.current.get(segIdx);
    if (!el) return;
    const seg = segs[segIdx];
    const span = Math.max(1, seg.end - seg.start + 1);
    const frac = Math.min(1, Math.max(0, (lineIdx - seg.start) / span));
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const offsetWithinContainer = elRect.top - containerRect.top + container.scrollTop;
    container.scrollTop = offsetWithinContainer + frac * elRect.height;
  }, []);

  const applyToSource = useCallback((editor: NonNullable<typeof monacoEditorRef.current>) => {
    const top = editor.getTopForLineNumber(sharedAnchorLineRef.current);
    editor.setScrollTop(top);
  }, []);

  useLayoutEffect(() => {
    if (!sourceMode) applyToPreview();
  }, [sourceMode, applyToPreview]);

  // ── Search (preview mode only) ───────────────────────────────────
  const search = useFileSearch(editorRef);

  // Track whether the segment was blank when activated (for slash detection)
  const segWasBlankOnActivate = useRef(false);
  const prevActiveSegIdx = useRef<number | null>(null);
  const slashCmdClose = slashCmd.close;
  useEffect(() => {
    if (activeSegIdx !== null && activeSegIdx !== prevActiveSegIdx.current) {
      const seg = segments[activeSegIdx];
      segWasBlankOnActivate.current = seg?.type === "blank";
    }
    if (activeSegIdx === null) {
      segWasBlankOnActivate.current = false;
      slashCmdClose();
    }
    prevActiveSegIdx.current = activeSegIdx;
  }, [activeSegIdx, segments, slashCmdClose]);

  const handleSlashSelect = useCallback(
    (item: SlashCommandItem) => {
      slashCmd.select(item);
      if (activeSegIdx === null) return;
      const seg = segments[activeSegIdx];
      if (!seg) return;

      // Special case: comment uses the existing comment system
      if (item.id === "comment") {
        // Clear the "/" from the blank line first
        setEditValue("");
        commitEdit();
        addComment(activeSegIdx);
        return;
      }

      const md = item.markdown;
      if (typeof md === "string") {
        // Single-line: replace editValue with the prefix
        setEditValue(md);
        // Position cursor after prefix
        requestAnimationFrame(() => {
          const el = inputRef.current;
          if (!el) return;
          if (item.cursor && typeof item.cursor === "string" && item.cursor.startsWith("select:")) {
            const [, startStr, endStr] = item.cursor.split(":");
            const s = Math.max(0, Math.min(Number(startStr), md.length));
            const e = Math.max(s, Math.min(Number(endStr), md.length));
            el.setSelectionRange(s, e);
          } else {
            el.setSelectionRange(md.length, md.length);
          }
          // Auto-resize textarea
          el.style.height = "auto";
          el.style.height = el.scrollHeight + "px";
        });
      } else {
        // Multi-line: splice into document
        const newLines = [...lines];
        newLines.splice(seg.start, seg.end - seg.start + 1, ...md);
        const newValue = newLines.join("\n");
        undoStack.push(newValue);
        setActiveSegIdx(null);
        clearHeightLock();
        applyContent(newValue);
        debouncedSave(newValue);

        // Activate the appropriate line
        if (typeof item.cursor === "number") {
          pendingActivateLineRef.current = seg.start + item.cursor;
        } else if (item.cursor === "end") {
          pendingActivateLineRef.current = seg.start + md.length - 1;
        } else if (typeof item.cursor === "string" && item.cursor.startsWith("select:")) {
          pendingActivateLineRef.current = seg.start;
          const [, startStr, endStr] = item.cursor.split(":");
          const firstLine = md[0] ?? "";
          const selectStart = Math.max(0, Math.min(Number(startStr), firstLine.length));
          const selectEnd = Math.max(selectStart, Math.min(Number(endStr), firstLine.length));
          pendingCursorPosRef.current = selectStart;
          const origPendingLine = seg.start;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const el = inputRef.current;
              if (el && pendingActivateLineRef.current === null) {
                el.setSelectionRange(selectStart, selectEnd);
              }
              if (
                el &&
                segments.findIndex(
                  (s) => s.start <= origPendingLine && s.end >= origPendingLine,
                ) === activeSegIdx
              ) {
                el.setSelectionRange(selectStart, selectEnd);
              }
            });
          });
        } else {
          pendingActivateLineRef.current = seg.start;
        }
      }
    },
    [
      activeSegIdx,
      segments,
      lines,
      setEditValue,
      inputRef,
      undoStack,
      setActiveSegIdx,
      clearHeightLock,
      applyContent,
      debouncedSave,
      pendingActivateLineRef,
      pendingCursorPosRef,
      slashCmd,
      addComment,
      commitEdit,
    ],
  );
  useEffect(() => {
    slashSelectRef.current = handleSlashSelect;
  });

  // Reset activeSegIdx when filePath changes (after hooks are initialized)
  useEffect(() => {
    setActiveSegIdx(null);
  }, [currentPath, setActiveSegIdx]);

  // Task checkbox toggle
  const toggleTask = useCallback(
    (lineIdx: number) => {
      const line = lines[lineIdx];
      const match = line.match(TASK_RE);
      if (!match) return;
      const newLines = [...lines];
      const checked = match[2] === "x" || match[2] === "X";
      newLines[lineIdx] = checked ? line.replace(/\[x\]/i, "[ ]") : line.replace(/\[ \]/, "[x]");
      const newValue = newLines.join("\n");
      undoStack.push(newValue);
      applyContent(newValue);
      debouncedSave(newValue);
    },
    [lines, undoStack, applyContent, debouncedSave],
  );

  // Table update handler (for InteractiveTable)
  const handleTableUpdate = useCallback(
    (seg: Segment, newTableLines: string[]) => {
      const newLines = [...lines];
      newLines.splice(seg.start, seg.end - seg.start + 1, ...newTableLines);
      const newValue = newLines.join("\n");
      undoStack.push(newValue);
      applyContent(newValue);
      debouncedSave(newValue);
    },
    [lines, undoStack, applyContent, debouncedSave],
  );

  // ── Drag-to-reorder segments ─────────────────────────────────
  const [dragSourceIdx, setDragSourceIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [dragSourceHeight, setDragSourceHeight] = useState(0);
  const dragStartY = useRef(0);
  const isDragging = useRef(false);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const dragHandleClickedRef = useRef(false);
  const dragSegRectsRef = useRef<DOMRect[]>([]);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // Clean up drag listeners if component unmounts mid-drag
  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  // ── Collapse / expand (Obsidian-style) ─────────────────────────
  const [collapsedSegments, setCollapsedSegments] = useState<Set<number>>(() => new Set());

  const toggleCollapse = useCallback((segIdx: number) => {
    setCollapsedSegments((prev) => {
      const next = new Set(prev);
      if (next.has(segIdx)) next.delete(segIdx);
      else next.add(segIdx);
      return next;
    });
  }, []);

  /** Get the indent level of a list-item line (number of leading spaces / 2) */
  const getListIndent = useCallback(
    (segIdx: number) => {
      const seg = segments[segIdx];
      if (!seg || seg.type !== "list-item") return 0;
      const line = lines[seg.start];
      const match = line.match(/^(\s*)/);
      return match ? Math.floor(match[1].length / 2) : 0;
    },
    [segments, lines],
  );

  /** Compute which segments are hidden by collapsed parents */
  const hiddenSegments = useMemo(() => {
    const hidden = new Set<number>();
    let i = 0;
    while (i < segments.length) {
      const seg = segments[i];

      // Heading collapse: hide everything until next heading of same/higher level
      if (seg.type === "heading" && seg.headingLevel && collapsedSegments.has(i)) {
        const level = seg.headingLevel;
        let j = i + 1;
        while (j < segments.length) {
          const next = segments[j];
          if (next.type === "heading" && next.headingLevel && next.headingLevel <= level) break;
          hidden.add(j);
          j++;
        }
        i = j;
        continue;
      }

      // List item collapse: hide indented children
      if (seg.type === "list-item" && collapsedSegments.has(i)) {
        const parentIndent = getListIndent(i);
        let j = i + 1;
        while (j < segments.length) {
          const next = segments[j];
          if (next.type !== "list-item") break;
          const childIndent = getListIndent(j);
          if (childIndent <= parentIndent) break;
          hidden.add(j);
          j++;
        }
        i = j;
        continue;
      }

      i++;
    }
    return hidden;
  }, [segments, collapsedSegments, getListIndent]);

  /** Check if a heading or list item has collapsible children after it */
  const hasCollapsibleChildren = useCallback(
    (segIdx: number) => {
      const seg = segments[segIdx];
      if (seg.type === "heading" && seg.headingLevel) {
        for (let j = segIdx + 1; j < segments.length; j++) {
          const next = segments[j];
          if (next.type === "heading" && next.headingLevel && next.headingLevel <= seg.headingLevel)
            return false;
          if (next.type !== "blank") return true;
        }
        return false;
      }
      if (seg.type === "list-item") {
        const myIndent = getListIndent(segIdx);
        const nextIdx = segIdx + 1;
        if (nextIdx < segments.length && segments[nextIdx].type === "list-item") {
          return getListIndent(nextIdx) > myIndent;
        }
        return false;
      }
      return false;
    },
    [segments, getListIndent],
  );

  // ── Progressive rendering for large documents ──────────────
  // Expand budget progressively until all segments are rendered
  useEffect(() => {
    if (renderBudget >= segments.length) return undefined;
    const id = requestAnimationFrame(() => {
      setRenderBudget((prev) => Math.min(prev + PROGRESSIVE_BATCH, segments.length));
    });
    return () => cancelAnimationFrame(id);
  }, [renderBudget, segments.length]);

  /** Segments deferred by progressive rendering (null when all rendered) */
  const deferredSegments = useMemo(() => {
    if (renderBudget >= segments.length) return null;
    const deferred = new Set<number>();
    let count = 0;
    for (let i = 0; i < segments.length; i++) {
      if (hiddenSegments.has(i)) continue;
      count++;
      if (count > renderBudget) deferred.add(i);
    }
    return deferred.size > 0 ? deferred : null;
  }, [segments, hiddenSegments, renderBudget]);

  const handleDragStart = useCallback(
    (segIdx: number, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragHandleClickedRef.current = true;
      dragStartY.current = e.clientY;
      isDragging.current = false;
      const startIdx = segIdx;
      let collectTimerId: ReturnType<typeof setTimeout> | undefined;

      // Helper: remove ghost element
      const removeGhost = () => {
        if (dragGhostRef.current) {
          dragGhostRef.current.remove();
          dragGhostRef.current = null;
        }
      };

      const onMove = (ev: MouseEvent) => {
        if (!isDragging.current && Math.abs(ev.clientY - dragStartY.current) > 4) {
          isDragging.current = true;

          // Create ghost preview: clone the segment element with "collecting" animation
          const editor = editorRef.current;
          if (editor) {
            const segEls = editor.querySelectorAll(".md-seg");
            const srcEl = segEls[startIdx];
            if (srcEl instanceof HTMLElement) {
              const srcRect = srcEl.getBoundingClientRect();
              // Capture height + rects before setting state (batched render)
              setDragSourceHeight(srcRect.height);
              // Capture unshifted rects for stable midpoint calculation during drag
              dragSegRectsRef.current = Array.from(segEls).map((el) => el.getBoundingClientRect());
              setDragSourceIdx(startIdx);
              const ghost = document.createElement("div");
              ghost.className = "md-seg-drag-ghost";
              // Start at segment position, will animate to cursor as a compact "cloud"
              ghost.style.cssText = `
                position: fixed; pointer-events: none; z-index: 9999;
                width: ${Math.min(srcEl.offsetWidth, 280)}px;
                max-height: 60px; overflow: hidden;
                left: ${srcRect.left + srcRect.width / 2}px;
                top: ${srcRect.top + srcRect.height / 2}px;
                transform: translate(-50%, -50%) scale(1);
                opacity: 0.6;
                border-radius: 8px;
                background: rgba(255,255,255,0.06);
                box-shadow: 0 2px 12px rgba(0,0,0,0.3);
                transition: left 150ms ease-out, top 150ms ease-out, transform 150ms ease-out, opacity 150ms ease-out, width 150ms ease-out, max-height 150ms ease-out;
              `;
              ghost.textContent = srcEl.textContent;
              document.body.appendChild(ghost);
              dragGhostRef.current = ghost;
              // Animate ghost to cursor — shrink into a compact cloud
              requestAnimationFrame(() => {
                if (dragGhostRef.current) {
                  dragGhostRef.current.style.left = `${ev.clientX}px`;
                  dragGhostRef.current.style.top = `${ev.clientY}px`;
                  dragGhostRef.current.style.transform = "translate(-50%, -50%) scale(0.55)";
                  dragGhostRef.current.style.opacity = "0.5";
                  dragGhostRef.current.style.width = `${Math.min(srcEl.offsetWidth * 0.7, 200)}px`;
                  dragGhostRef.current.style.maxHeight = "40px";
                }
              });
              // Remove transition after collect animation so cursor tracking is instant
              collectTimerId = setTimeout(() => {
                if (dragGhostRef.current) {
                  dragGhostRef.current.style.transition = "none";
                }
              }, 160);
            }
          }
        }
        if (!isDragging.current) return;

        // Move ghost to follow cursor
        if (dragGhostRef.current) {
          dragGhostRef.current.style.left = `${ev.clientX}px`;
          dragGhostRef.current.style.top = `${ev.clientY}px`;
        }

        // Find which segment we're hovering over (use stored rects to avoid shift feedback)
        const rects = dragSegRectsRef.current;
        if (rects.length === 0) return;
        let closest = -1;
        let minDist = Infinity;
        for (let i = 0; i < rects.length; i++) {
          const midY = rects[i].top + rects[i].height / 2;
          const dist = Math.abs(ev.clientY - midY);
          if (dist < minDist) {
            minDist = dist;
            closest = i;
          }
        }
        // Determine if we should drop above or below the closest segment
        if (closest >= 0) {
          const midY = rects[closest].top + rects[closest].height / 2;
          const dropIdx = ev.clientY > midY ? closest + 1 : closest;
          setDragOverIdx(dropIdx);
        }
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        dragCleanupRef.current = null;
        clearTimeout(collectTimerId);
        removeGhost();
        if (isDragging.current) {
          // Deactivate any active segment before reordering — if a segment was
          // being edited when the drag started, blur was suppressed by
          // mouseDownInsideRef. Without this, activeSegIdx would point at the
          // wrong content after the reorder.
          commitEdit();

          setDragSourceIdx((srcIdx) => {
            setDragOverIdx((overIdx) => {
              if (
                srcIdx !== null &&
                overIdx !== null &&
                overIdx !== srcIdx &&
                overIdx !== srcIdx + 1
              ) {
                // Perform the reorder
                const srcSeg = segments[srcIdx];
                const srcLines = lines.slice(srcSeg.start, srcSeg.end + 1);

                const newLines = [...lines];
                // Remove source lines
                newLines.splice(srcSeg.start, srcSeg.end - srcSeg.start + 1);

                // Calculate insert position after removal
                let insertLine: number;
                if (overIdx > srcIdx) {
                  // Moving down: target segments shifted up by removed count
                  const targetSegIdx = Math.min(overIdx - 1, segments.length - 1);
                  const targetSeg = segments[targetSegIdx];
                  insertLine = targetSeg.end + 1 - (srcSeg.end - srcSeg.start + 1);
                } else {
                  // Moving up: target not affected by removal
                  const targetSeg = segments[overIdx];
                  insertLine = targetSeg.start;
                }
                insertLine = Math.max(0, Math.min(insertLine, newLines.length));
                newLines.splice(insertLine, 0, ...srcLines);
                const newValue = newLines.join("\n");
                undoStack.push(newValue);
                applyContent(newValue);
                debouncedSave(newValue);
              }
              return null;
            });
            return null;
          });
        } else {
          // Click without drag → activate segment with all text selected
          activateSegment(startIdx, "all");
        }
        isDragging.current = false;
        dragHandleClickedRef.current = false;
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      dragCleanupRef.current = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        removeGhost();
      };
    },
    [segments, lines, undoStack, applyContent, debouncedSave, activateSegment, commitEdit],
  );

  // ── Context menu ────────────────────────────────────────────
  const contextInfoRef = useRef<{
    segIdx: number;
    selMarkdown: string | null;
    /** Rendered text the user actually selected (for partial selection copy/cut) */
    selRenderedText: string | null;
    selStartSeg: number;
    selEndSeg: number;
    /** Whether the selection is partial within a single segment */
    isPartialSelection: boolean;
    /** AST-derived character offsets for the partial selection */
    mdRange: MarkdownRange | null;
  } | null>(null);
  const { menu: ctxMenu, open: openCtxMenu, close: closeCtxMenu } = useCreateContextMenu();

  // Capture context info on right-click and open custom context menu
  const captureContextInfo = useCallback(
    (segIdx: number, e: React.MouseEvent) => {
      e.preventDefault();
      const seg = segments[segIdx];
      if (!seg || seg.type === "table" || seg.type === "comment") return;
      const md = getSelectionMarkdown();
      const editor = editorRef.current;
      let selStartSeg = segIdx;
      let selEndSeg = segIdx;
      let isPartialSelection = false;
      let selRenderedText: string | null = null;
      let mdRange: MarkdownRange | null = null;
      if (md && editor) {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) {
          const info = detectPartialSelection(sel, editor, segments);
          if (info) {
            selRenderedText = info.renderedText;
            selStartSeg = info.startSeg;
            selEndSeg = info.endSeg;
            isPartialSelection = info.isPartial;
            mdRange = info.mdRange;
          }
        }
      }
      contextInfoRef.current = {
        segIdx,
        selMarkdown: md,
        selRenderedText,
        selStartSeg,
        selEndSeg,
        isPartialSelection,
        mdRange,
      };
      openCtxMenu(e);
    },
    [segments, getSelectionMarkdown, openCtxMenu],
  );

  // Copy handler for context menu
  const handleContextCopy = useCallback(() => {
    const info = contextInfoRef.current;
    if (!info) return;
    if (activeSegIdx === info.segIdx) {
      document.execCommand("copy");
    } else if (info.isPartialSelection && info.selRenderedText) {
      void navigator.clipboard.writeText(info.selRenderedText);
    } else {
      const seg = segments[info.segIdx];
      const text =
        info.selMarkdown || (seg ? lines.slice(seg.start, seg.end + 1).join("\n") : null);
      if (text) {
        void navigator.clipboard.writeText(text);
      }
    }
  }, [activeSegIdx, segments, lines]);

  const handleContextCut = useCallback(() => {
    const info = contextInfoRef.current;
    if (!info) return;
    if (activeSegIdx === info.segIdx) {
      document.execCommand("cut");
      return;
    }
    // Partial single-segment selection → copy selected text, delete from
    // raw markdown using AST-derived offsets, and activate edit mode
    if (info.isPartialSelection && info.mdRange) {
      if (info.selRenderedText) {
        void navigator.clipboard.writeText(info.selRenderedText);
      }
      dispatchPartialEdit(info.mdRange, "", info.segIdx);
      return;
    }
    // Use selection range captured at right-click time
    const startSeg = info.selStartSeg;
    const endSeg = Math.min(info.selEndSeg, segments.length - 1);
    const firstSeg = segments[startSeg];
    const lastSeg = segments[endSeg];
    if (!firstSeg || !lastSeg) return;
    const text = info.selMarkdown || lines.slice(firstSeg.start, lastSeg.end + 1).join("\n");
    void navigator.clipboard.writeText(text);
    // Remove the segment range lines
    const newLines = [...lines];
    newLines.splice(firstSeg.start, lastSeg.end - firstSeg.start + 1);
    if (newLines.length === 0) newLines.push("");
    const newValue = newLines.join("\n");
    undoStack.push(newValue);
    applyContent(newValue);
    debouncedSave(newValue);
  }, [activeSegIdx, segments, lines, undoStack, applyContent, debouncedSave, dispatchPartialEdit]);

  const handleContextPaste = useCallback(async () => {
    const info = contextInfoRef.current;
    if (!info) return;
    try {
      if (activeSegIdx === info.segIdx) {
        // In edit mode — read from clipboard and insert at cursor
        const ta = inputRef.current;
        const clipText = await navigator.clipboard.readText();
        if (ta && clipText) {
          const start = ta.selectionStart;
          const end = ta.selectionEnd;
          const before = editValue.substring(0, start);
          const after = editValue.substring(end);
          const newVal = before + clipText + after;
          setEditValue(newVal);
          requestAnimationFrame(() => {
            if (ta) ta.selectionStart = ta.selectionEnd = start + clipText.length;
          });
        }
        return;
      }
      // In rendered mode with partial selection: replace selected text with clipboard
      // using AST-derived offsets
      if (info.isPartialSelection && info.mdRange) {
        void dispatchPartialEditFromClipboard(info.mdRange, info.segIdx);
        return;
      }
      // In rendered mode: insert clipboard text after the right-clicked segment
      const seg = segments[info.segIdx];
      if (!seg) return;
      const clipText = await navigator.clipboard.readText();
      if (clipText) {
        const newLines = [...lines];
        const insertAt = seg.end + 1;
        const pasteLines = clipText.split("\n");
        newLines.splice(insertAt, 0, ...pasteLines);
        const newValue = newLines.join("\n");
        undoStack.push(newValue);
        applyContent(newValue);
        debouncedSave(newValue);
      }
    } catch {
      // Clipboard read can fail if document loses focus
    }
  }, [
    activeSegIdx,
    editValue,
    setEditValue,
    segments,
    lines,
    undoStack,
    applyContent,
    debouncedSave,
    dispatchPartialEditFromClipboard,
  ]);

  // Global keyboard shortcuts (undo/redo, copy/cut/delete raw markdown)
  // Registered on document so they fire even when no element inside the editor is focused
  // (e.g. user has a text selection across rendered segments)
  // Keyboard handler — uses useEffectEvent to always read latest state
  // without re-registering the listener on every state change.
  const handleEditorKeyDown = useEffectEvent((e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;

    // Cmd+F — open search bar (preview mode only)
    if (mod && e.key === "f" && !sourceMode) {
      e.preventDefault();
      e.stopPropagation();
      search.open();
      return;
    }

    // Escape — close search bar
    if (e.key === "Escape" && search.state.isOpen) {
      e.preventDefault();
      e.stopPropagation();
      search.close();
      return;
    }

    // Don't process editor shortcuts when typing inside the search bar
    if (e.target instanceof HTMLElement && e.target.closest('[data-testid="search-bar"]')) {
      return;
    }

    const editor = editorRef.current;
    if (!editor) return;

    // Don't intercept when focus is on an editable element outside the editor
    // (e.g. the chat input box in the right panel)
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      !editor.contains(active) &&
      (active.tagName === "TEXTAREA" || active.tagName === "INPUT" || active.isContentEditable)
    ) {
      return;
    }

    // Helper: remove lines covered by a segment range and save
    const removeSegRange = (startSeg: number, endSeg: number) => {
      const firstSeg = segments[startSeg];
      const lastSeg = segments[Math.min(endSeg, segments.length - 1)];
      const activateAt = firstSeg.start;
      const newLines = [...lines];
      newLines.splice(firstSeg.start, lastSeg.end - firstSeg.start + 1);
      if (newLines.length === 0) newLines.push("");
      const newValue = newLines.join("\n");
      undoStack.push(newValue);
      applyContent(newValue);
      debouncedSave(newValue);
      // Place cursor at the deletion point
      pendingActivateLineRef.current = Math.min(activateAt, newLines.length - 1);
    };

    // Cmd+Z / Cmd+Shift+Z — undo/redo
    if (mod && (e.key === "z" || e.key === "Z")) {
      // If the textarea's onKeyDown already handled this (edit-level undo/redo),
      // it set editUndoHandledRef. Read and reset the flag to avoid double-firing.
      if (editUndoHandledRef.current) {
        editUndoHandledRef.current = false;
        return;
      }

      // While editing a segment, the textarea keydown handlers manage a custom
      // edit-level undo stack with word-boundary grouping. When that stack is
      // exhausted (user undid back to the segment's original text), transition
      // to document-level undo/redo so rendered-mode operations (delete, cut,
      // etc.) can be reverted — fixing the gap where auto-activated
      // segments had no native undo history.
      if (activeSegIdx !== null) {
        const isUndo = !e.shiftKey;
        // Asymmetric gate: undo escapes once the in-segment stack has nothing
        // left to roll back, but redo only escapes when the stack is fully at
        // initial AND has nothing to redo locally. Uncommitted edits diverge
        // from doc state, so escaping with pending in-segment redo history
        // would silently lose the user's typing.
        const editExhausted = isUndo
          ? editUndo.isAtInitial()
          : editUndo.isAtInitial() && !editUndo.canRedo();
        if (editExhausted) {
          // Peek at doc-level stack — only deactivate if there's something to
          // undo/redo. Otherwise stay in the segment (cursor stays visible).
          const docValue = isUndo ? undoStack.undo() : undoStack.redo();
          if (docValue !== null) {
            commitEdit();
            e.preventDefault();
            e.stopPropagation();
            applyContent(docValue);
            if (docValue !== lastSavedRef.current) {
              lastSavedRef.current = docValue;
              void window.workspaceAPI?.writeFile(filePath, docValue);
            }
          }
        }
        // Otherwise the textarea's onKeyDown handler already handled it
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const value = e.shiftKey ? undoStack.redo() : undoStack.undo();
      if (value !== null) {
        applyContent(value);
        if (value !== lastSavedRef.current) {
          lastSavedRef.current = value;
          void window.workspaceAPI?.writeFile(filePath, value);
        }
      }
      return;
    }

    // Partial single-segment selection in rendered mode → enter edit mode
    // and apply the destructive operation to the matching text in the raw
    // markdown using precise character offsets from the AST annotations.
    // Also handles Cmd+C on partial selections (lets browser copy natively).
    if (editor) {
      const handled = tryHandlePartialSelectionKey(e, {
        editor,
        segments,
        activeSegIdx,
        dispatchPartialEdit,
        dispatchPartialEditFromClipboard,
      });
      if (handled) return;
    }

    // Backspace / Delete — remove selected segments in rendered mode
    // Also works when a cross-segment selection exists even if activeSegIdx is set
    // (e.g. after Shift+Arrow exits edit mode but React hasn't fully cleared the textarea)
    if (e.key === "Backspace" || e.key === "Delete") {
      const range = getSelectedSegRange();
      if (range && range.endSeg > range.startSeg) {
        e.preventDefault();
        e.stopPropagation();
        setActiveSegIdx(null);
        removeSegRange(range.startSeg, range.endSeg);
        return;
      }
      // Single-segment backspace only in rendered mode
      if (range && activeSegIdx === null) {
        e.preventDefault();
        e.stopPropagation();
        removeSegRange(range.startSeg, range.endSeg);
        return;
      }
    }

    // ArrowLeft on rendered selection → activate start segment at start
    // ArrowRight on rendered selection → activate end segment at end
    // ArrowUp on rendered selection → activate start segment at start
    // ArrowDown on rendered selection → activate end segment at end
    if (
      (e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowDown") &&
      !e.shiftKey &&
      !mod &&
      activeSegIdx === null
    ) {
      const range = getSelectedSegRange();
      if (range) {
        e.preventDefault();
        e.stopPropagation();
        window.getSelection()?.removeAllRanges();
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          activateSegment(range.startSeg, "start");
        } else {
          activateSegment(range.endSeg, "end");
        }
        return;
      }
    }

    // Shift+ArrowDown / Shift+ArrowUp — extend selection across segment divs.
    // Browser's native Shift+Arrow stops at block element boundaries. We
    // preventDefault and use Selection.extend() to cross into adjacent segments.
    if (
      e.shiftKey &&
      !mod &&
      (e.key === "ArrowDown" || e.key === "ArrowUp") &&
      activeSegIdx === null
    ) {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      e.preventDefault();
      e.stopPropagation();

      const segEls = editor.querySelectorAll(".md-seg");
      // Find which segment the current focus is in
      let focusSeg = -1;
      for (let i = 0; i < segEls.length; i++) {
        if (segEls[i].contains(sel.focusNode)) {
          focusSeg = i;
          break;
        }
      }
      if (focusSeg < 0) return;

      const targetIdx = e.key === "ArrowDown" ? focusSeg + 1 : focusSeg - 1;
      if (targetIdx < 0 || targetIdx >= segEls.length) return;

      const targetEl = segEls[targetIdx].querySelector(".md-seg-rendered") || segEls[targetIdx];
      if (!targetEl.firstChild) return;

      // Extend into next/prev segment
      if (e.key === "ArrowDown") {
        // Extend focus to end of next segment (deepest last text node)
        let node: Node = targetEl;
        while (node.lastChild) node = node.lastChild;
        sel.extend(node, node.textContent?.length ?? 0);
      } else {
        // Extend focus to start of previous segment (first text node)
        const node = targetEl.firstChild || targetEl;
        sel.extend(node, 0);
      }
      return;
    }

    // Enter with selection → delete selected, insert blank line, activate it
    if (e.key === "Enter" && !mod) {
      const range = getSelectedSegRange();
      if (range && activeSegIdx === null) {
        e.preventDefault();
        e.stopPropagation();
        const firstSeg = segments[range.startSeg];
        const lastSeg = segments[Math.min(range.endSeg, segments.length - 1)];
        const newLines = [...lines];
        newLines.splice(firstSeg.start, lastSeg.end - firstSeg.start + 1, "");
        if (newLines.length === 0) newLines.push("");
        const newValue = newLines.join("\n");
        undoStack.push(newValue);
        applyContent(newValue);
        debouncedSave(newValue);
        pendingActivateLineRef.current = Math.min(firstSeg.start, newLines.length - 1);
        return;
      }
    }

    // Printable character with selection → delete selected, type that character
    if (e.key.length === 1 && !mod && !e.altKey && activeSegIdx === null) {
      const range = getSelectedSegRange();
      if (range) {
        e.preventDefault();
        e.stopPropagation();
        const firstSeg = segments[range.startSeg];
        const lastSeg = segments[Math.min(range.endSeg, segments.length - 1)];
        const newLines = [...lines];
        newLines.splice(firstSeg.start, lastSeg.end - firstSeg.start + 1, e.key);
        const newValue = newLines.join("\n");
        undoStack.push(newValue);
        applyContent(newValue);
        debouncedSave(newValue);
        pendingActivateLineRef.current = Math.min(firstSeg.start, newLines.length - 1);
        pendingCursorPosRef.current = e.key.length;
        return;
      }
    }

    // Below here: need Cmd/Ctrl modifier
    if (!mod) return;

    // Cmd+C — copy raw markdown from rendered selection
    // Partial single-segment selections are already handled by
    // tryHandlePartialSelectionKey above (lets browser copy natively).
    if (e.key === "c" && activeSegIdx === null) {
      const md = getSelectionMarkdown();
      if (md) {
        void navigator.clipboard.writeText(md);
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    // Cmd+X — cut: copy raw markdown + remove selected segments
    if (e.key === "x" && activeSegIdx === null) {
      const range = getSelectedSegRange();
      if (range) {
        const firstSeg = segments[range.startSeg];
        const lastSeg = segments[Math.min(range.endSeg, segments.length - 1)];
        void navigator.clipboard.writeText(lines.slice(firstSeg.start, lastSeg.end + 1).join("\n"));
        removeSegRange(range.startSeg, range.endSeg);
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    // Cmd+K — add comment after selection or focused segment
    if (e.key === "k") {
      e.preventDefault();
      e.stopPropagation();
      const range = getSelectedSegRange();
      const targetSeg = range
        ? range.endSeg
        : (() => {
            // No selection — find segment under focus
            const sel = window.getSelection();
            if (!sel?.focusNode || !editor) return -1;
            const segEls = editor.querySelectorAll(".md-seg");
            for (let i = 0; i < segEls.length; i++) {
              if (segEls[i].contains(sel.focusNode)) return i;
            }
            return -1;
          })();
      if (targetSeg >= 0) {
        window.getSelection()?.removeAllRanges();
        if (range && range.endSeg > range.startSeg) {
          // Multi-segment selection → anchored comment
          addComment(targetSeg, range.startSeg, range.endSeg);
        } else {
          addComment(targetSeg);
        }
      }
      return;
    }

    // Cmd+V — paste clipboard text after selected/focused segment
    if (e.key === "v" && activeSegIdx === null) {
      e.preventDefault();
      e.stopPropagation();
      void (async () => {
        try {
          const clipText = await navigator.clipboard.readText();
          if (!clipText) return;
          const range = getSelectedSegRange();
          const insertAfterSeg = range ? range.endSeg : segments.length - 1;
          const seg = segments[Math.min(insertAfterSeg, segments.length - 1)];
          if (!seg) return;
          const newLines = [...lines];
          const pastedLines = clipText.split("\n");
          newLines.splice(seg.end + 1, 0, ...pastedLines);
          const newValue = newLines.join("\n");
          undoStack.push(newValue);
          applyContent(newValue);
          debouncedSave(newValue);
          // Place cursor at end of last pasted line
          const lastPastedLine = seg.end + pastedLines.length;
          pendingActivateLineRef.current = lastPastedLine;
          pendingCursorPosRef.current = "end";
        } catch {
          // Clipboard read can fail if document loses focus
        }
      })();
      return;
    }

    // Cmd+A — first press selects the segment under cursor, second selects all
    if (e.key === "a" && activeSegIdx === null) {
      e.preventDefault();
      e.stopPropagation();
      const sel = window.getSelection();
      if (!sel) return;
      const segEls = editor.querySelectorAll(".md-seg");
      if (!segEls.length) return;

      // Determine if the current selection already covers a full single segment
      let anchorSeg = -1;
      let focusSeg2 = -1;
      for (let i = 0; i < segEls.length; i++) {
        if (sel.anchorNode && segEls[i].contains(sel.anchorNode)) anchorSeg = i;
        if (sel.focusNode && segEls[i].contains(sel.focusNode)) focusSeg2 = i;
      }
      const isSingleSegSelected = !sel.isCollapsed && anchorSeg >= 0 && anchorSeg === focusSeg2;

      if (isSingleSegSelected) {
        // Already have one segment selected — expand to entire document
        const allRange = document.createRange();
        allRange.setStartBefore(segEls[0]);
        allRange.setEndAfter(segEls[segEls.length - 1]);
        sel.removeAllRanges();
        sel.addRange(allRange);
      } else if (sel.focusNode) {
        // Select the segment containing the cursor
        let fSeg = -1;
        for (let i = 0; i < segEls.length; i++) {
          if (segEls[i].contains(sel.focusNode)) {
            fSeg = i;
            break;
          }
        }
        if (fSeg >= 0) {
          const segRange = document.createRange();
          segRange.selectNodeContents(segEls[fSeg]);
          sel.removeAllRanges();
          sel.addRange(segRange);
        }
      }
      return;
    }
  });

  useEffect(() => {
    document.addEventListener("keydown", handleEditorKeyDown);
    return () => document.removeEventListener("keydown", handleEditorKeyDown);
  }, []); // handleEditorKeyDown is stable (useEffectEvent)

  const undoStackPush = undoStack.push;
  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      const v = value ?? "";
      undoStackPush(v);
      applyContent(v);
      debouncedSave(v);
    },
    [undoStackPush, applyContent, debouncedSave],
  );

  const fileName = filePath.split("/").pop() ?? filePath;
  const ext = fileName.includes(".") ? (fileName.split(".").pop()?.toLowerCase() ?? "") : "";
  const isMarkdown = content?.type === "markdown";
  const isHtml = content?.type === "html";
  const supportsSourceMode = isMarkdown || isHtml;
  const htmlPreviewSrc = useMemo(() => {
    if (!isHtml) return "";
    return appendQueryParam(buildLocalPreviewUrl(filePath), "marshalTheme", theme);
  }, [filePath, isHtml, theme]);

  // Non-textual files: show "Open in App" card instead of preview
  const BINARY_EXTS = new Set([
    "docx",
    "doc",
    "xlsx",
    "xls",
    "pptx",
    "ppt",
    "pdf",
    "zip",
    "rar",
    "7z",
    "tar",
    "gz",
    "mp3",
    "mp4",
    "wav",
    "avi",
    "mov",
    "mkv",
    "exe",
    "dmg",
    "msi",
    "pkg",
    "deb",
    "rpm",
    "sketch",
    "fig",
    "ai",
    "psd",
    "indd",
  ]);
  const isBinaryFile = BINARY_EXTS.has(ext);

  const FILE_ICONS: Record<string, string> = {
    docx: "📝",
    doc: "📝",
    xlsx: "📊",
    xls: "📊",
    pptx: "📑",
    ppt: "📑",
    pdf: "📕",
    zip: "🗜️",
    rar: "🗜️",
    "7z": "🗜️",
    mp3: "🎵",
    wav: "🎵",
    mp4: "🎬",
    mov: "🎬",
    psd: "🎨",
    ai: "🎨",
    sketch: "🎨",
    fig: "🎨",
  };

  if (loading) {
    return (
      <div className="flex size-full flex-col overflow-hidden">
        <div className="flex h-full flex-col items-center justify-center text-[13px] text-muted-foreground">
          Loading…
        </div>
      </div>
    );
  }

  if (error && !isBinaryFile) {
    const isTooLarge = error === "File too large to preview";
    return (
      <div className="flex size-full flex-col overflow-hidden">
        <div className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-destructive">
          {error}
          {isTooLarge && (
            <>
              <button
                className="cursor-pointer rounded-md border-none bg-primary px-5 py-2 font-[inherit] text-[13px] font-medium text-primary-foreground transition-opacity duration-150 hover:opacity-85"
                onClick={() =>
                  readCapability === undefined
                    ? window.workspaceAPI?.openFile(filePath)
                    : window.workspaceAPI?.openFile(filePath, readCapability)
                }
              >
                Open in Desktop App
              </button>
              <button
                className="cursor-pointer rounded-sm border border-border bg-transparent px-3 py-1 font-[inherit] text-xs text-muted-foreground hover:border-muted-foreground hover:text-foreground"
                onClick={() =>
                  readCapability === undefined
                    ? window.workspaceAPI?.revealInFileManager(filePath)
                    : window.workspaceAPI?.revealInFileManager(filePath, readCapability)
                }
              >
                Show in {window.platform === "darwin" ? "Finder" : "Explorer"}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (isBinaryFile) {
    const icon = FILE_ICONS[ext] ?? "📄";
    return (
      <div className="flex size-full flex-col overflow-hidden">
        <div className="flex h-full flex-col items-center justify-center gap-2 p-10">
          <div className="text-[64px] leading-none">{icon}</div>
          <div className="text-center text-base font-semibold break-all text-foreground">
            {fileName}
          </div>
          <div className="text-xs tracking-[0.5px] text-muted-foreground uppercase">
            .{ext.toUpperCase()} file
          </div>
          <button
            className="mt-3 cursor-pointer rounded-md border-none bg-primary px-5 py-2 font-[inherit] text-[13px] font-medium text-primary-foreground transition-opacity duration-150 hover:opacity-85"
            onClick={() =>
              readCapability === undefined
                ? window.workspaceAPI?.openFile(filePath)
                : window.workspaceAPI?.openFile(filePath, readCapability)
            }
          >
            Open in Desktop App
          </button>
          <button
            className="cursor-pointer rounded-sm border border-border bg-transparent px-3 py-1 font-[inherit] text-xs text-muted-foreground hover:border-muted-foreground hover:text-foreground"
            onClick={() =>
              readCapability === undefined
                ? window.workspaceAPI?.revealInFileManager(filePath)
                : window.workspaceAPI?.revealInFileManager(filePath, readCapability)
            }
          >
            Show in {window.platform === "darwin" ? "Finder" : "Explorer"}
          </button>
        </div>
      </div>
    );
  }

  if (!content) return null;

  return (
    <div data-testid="file-preview-root" className="flex size-full flex-col overflow-hidden">
      {supportsSourceMode && (
        <div className="shrink-0">
          <div className="flex gap-0.5 border-b border-border bg-card px-4 py-1.5">
            <button
              className={`cursor-pointer rounded-sm border-none bg-transparent px-2.5 py-[3px] font-[inherit] text-xs text-muted-foreground hover:text-foreground hover:bg-muted${!sourceMode ? " bg-muted font-semibold text-foreground" : ""}`}
              onClick={() => {
                if (sourceMode) captureFromSource();
                setSourceMode(false);
                setActiveSegIdx(null);
              }}
              title="Rendered view"
            >
              Preview
            </button>
            <button
              className={`cursor-pointer rounded-sm border-none bg-transparent px-2.5 py-[3px] font-[inherit] text-xs text-muted-foreground hover:text-foreground hover:bg-muted${sourceMode ? " bg-muted font-semibold text-foreground" : ""}`}
              onClick={() => {
                if (!sourceMode) captureFromPreview();
                if (search.state.isOpen) search.close();
                if (activeSegIdx !== null) commitEdit();
                setSourceMode(true);
              }}
              title={isHtml ? "Edit raw HTML" : "Edit raw markdown"}
            >
              Source
            </button>
          </div>
          {/* SearchBar: only in preview mode, hangs below header */}
          {!sourceMode && (
            <div className="relative z-40 h-0 overflow-visible">
              <div className="absolute top-0 right-4">
                <SearchBar
                  state={search.state}
                  onQueryChange={search.setQuery}
                  onNext={search.nextMatch}
                  onPrev={search.prevMatch}
                  onClose={search.close}
                  onToggleOption={search.toggleOption}
                />
              </div>
            </div>
          )}
        </div>
      )}
      <div
        ref={scrollContainerRef}
        data-testid="file-preview-content"
        className={`relative flex-1 ${isHtml && !sourceMode ? "overflow-hidden p-0" : sourceMode ? "overflow-hidden p-4" : "overflow-y-auto p-4"}`}
        style={
          // Apply zoom on the parent for markdown rendering — works because
          // markdown content is sized in `em`/`px` and reflows naturally.
          // Image and HTML iframe surfaces handle zoom themselves below
          // (the parent's CSS `zoom` doesn't reliably scale replaced
          // elements once `vh` / `%` constraints are involved). Monaco is
          // excluded entirely.
          isMarkdown && !sourceMode && Math.abs(zoom - 1) > ZOOM_EPSILON ? { zoom } : undefined
        }
      >
        {content.type === "image" && (
          <img
            src={content.content}
            alt={fileName}
            // Scale the size constraints with `zoom` so the image grows /
            // shrinks linearly with the user-chosen zoom level. We don't
            // rely on CSS `zoom` here because Chromium adjusts `vh` units
            // for descendants of a zoomed ancestor, which actually shrinks
            // the image as the user zooms in.
            style={{
              maxWidth: `${zoom * 100}%`,
              maxHeight: `${zoom * 70}vh`,
            }}
            className="rounded-md bg-[repeating-conic-gradient(#e5e5e5_0%_25%,transparent_0%_50%)] bg-size-[16px_16px] object-contain"
          />
        )}
        {isHtml && !sourceMode && (
          <iframe
            title={`${fileName} preview`}
            data-testid="html-preview"
            sandbox="allow-scripts"
            src={htmlPreviewSrc}
            referrerPolicy="no-referrer"
            // Same rationale as the <img> above — apply zoom on the iframe
            // directly so size doesn't depend on parent vh/% interactions.
            style={Math.abs(zoom - 1) > ZOOM_EPSILON ? { zoom } : undefined}
            className="block size-full border-none bg-background"
          />
        )}
        {isMarkdown && !sourceMode && (
          <>
            <div
              ref={editorRef}
              className="md-custom-editor pl-8 font-['-apple-system',BlinkMacSystemFont,'Segoe_UI',Roboto,sans-serif] text-sm leading-[1.6] text-[hsl(0,0%,25%)] dark:text-[hsl(0,0%,82%)]"
              onCopy={handleCopy}
              onClick={() => {
                if (search.state.isOpen) search.close();
              }}
            >
              {segments.map((seg, segIdx) => {
                const isActive = activeSegIdx === segIdx;
                const isSingleLine = seg.start === seg.end;
                const level = seg.type === "heading" ? seg.headingLevel : 0;
                const isComment = seg.type === "comment";
                const anchorId = seg.type === "comment" ? seg.anchorId : undefined;

                // Skip hidden (collapsed) segments
                if (hiddenSegments.has(segIdx)) return null;

                // Progressive rendering: deferred segments get lightweight placeholder
                if (deferredSegments?.has(segIdx)) {
                  return (
                    <div
                      key={`${seg.start}-${seg.type}`}
                      className={`md-seg md-seg-${seg.type}`}
                      // ~22px per line: 13px font × 1.6 line-height ≈ 20.8, rounded up
                      style={{ minHeight: (seg.end - seg.start + 1) * 22 }}
                    />
                  );
                }

                const isCollapsible = hasCollapsibleChildren(segIdx);
                const isCollapsed = collapsedSegments.has(segIdx);

                // CSS class for segment type
                let segClass = `md-seg relative cursor-text rounded-[3px] px-1 py-px transition-[background-color] duration-100 hover:bg-[rgba(255,255,255,0.02)] md-seg-${seg.type}`;
                if (level) segClass += ` md-seg-h${level}`;
                if (isActive && !isComment)
                  segClass +=
                    " md-seg-active bg-[rgba(255,255,255,0.06)] rounded outline outline-1 outline-[rgba(255,255,255,0.1)]";
                if (seg.type === "blockquote") segClass += " border-l-[3px] border-l-primary pl-4";
                if (seg.type === "blank") segClass += " min-h-[1.5em]";

                const hasCtxMenu = seg.type !== "table" && seg.type !== "comment";

                // Compute drag shift styles for live reorder preview
                const segStyle: React.CSSProperties = {};
                if (isActive && lockedHeight) segStyle.minHeight = lockedHeight;
                if (dragSourceIdx !== null) {
                  segStyle.transition = "transform 200ms ease, opacity 150ms ease";
                  if (segIdx === dragSourceIdx) {
                    segStyle.opacity = 0.15;
                  } else if (dragOverIdx !== null) {
                    const srcH = dragSourceHeight;
                    if (
                      dragOverIdx <= dragSourceIdx &&
                      segIdx >= dragOverIdx &&
                      segIdx < dragSourceIdx
                    ) {
                      // Moving up: push segments down to make room
                      segStyle.transform = `translateY(${srcH}px)`;
                    } else if (
                      dragOverIdx > dragSourceIdx + 1 &&
                      segIdx > dragSourceIdx &&
                      segIdx < dragOverIdx
                    ) {
                      // Moving down: pull segments up to fill gap
                      segStyle.transform = `translateY(-${srcH}px)`;
                    }
                  }
                }

                const segDiv = (
                  <div
                    key={`${seg.start}-${seg.type}`}
                    className={segClass}
                    data-testid={`segment-${segIdx}`}
                    ref={(el: HTMLDivElement | null) => {
                      if (el) segmentElsRef.current.set(segIdx, el);
                      else segmentElsRef.current.delete(segIdx);
                      if (isActive) setSlashAnchorEl(el);
                    }}
                    style={Object.keys(segStyle).length > 0 ? segStyle : undefined}
                    onClick={(e) => {
                      if (dragHandleClickedRef.current) {
                        dragHandleClickedRef.current = false;
                        return;
                      }
                      handleSegClick(segIdx, e);
                    }}
                    onMouseDown={(e) => handleSegMouseDown(segIdx, e)}
                    onContextMenu={
                      hasCtxMenu
                        ? (e: React.MouseEvent) => {
                            captureContextInfo(segIdx, e);
                          }
                        : undefined
                    }
                  >
                    {/* Gutter zone: hit area + drag handle (CSS hover shows handle) */}
                    {!isActive && !isComment && seg.type !== "blank" && (
                      <>
                        <div className="pointer-events-auto absolute inset-y-0 -left-11 w-11" />
                        <div
                          className="md-seg-drag-handle pointer-events-none invisible absolute top-1/2 -left-10 z-20 flex size-5 -translate-y-1/2 cursor-grab items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-[opacity,background-color,color] duration-100 hover:bg-muted hover:text-foreground active:cursor-grabbing"
                          title="Drag to reorder"
                          onMouseDown={(e) => handleDragStart(segIdx, e)}
                        >
                          <GripVertical className="size-3.5" />
                        </div>
                      </>
                    )}
                    {/* Collapse chevron for headings and parent list items */}
                    {!isActive && isCollapsible && (
                      <button
                        className={`md-seg-collapse absolute top-1/2 -left-5 z-10 flex size-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground/60 transition-all duration-150 hover:text-foreground ${isCollapsed ? "" : "rotate-90"}`}
                        title={isCollapsed ? "Expand" : "Collapse"}
                        aria-expanded={!isCollapsed}
                        aria-label={isCollapsed ? "Expand section" : "Collapse section"}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleCollapse(segIdx);
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        <ChevronRight className="size-3" />
                      </button>
                    )}

                    {isActive ? (
                      <textarea
                        ref={inputRef}
                        className={
                          isSingleLine
                            ? "md-seg-input m-0 box-border block min-h-[1.5em] w-full resize-none border-none bg-transparent p-0 leading-[inherit] wrap-break-word whitespace-pre-wrap text-foreground outline-none [font:inherit]"
                            : "md-seg-textarea m-0 box-border block w-full resize-none rounded-md border border-border bg-muted px-3 py-2 font-mono text-[0.88em] leading-normal text-foreground outline-none [font:inherit]"
                        }
                        value={editValue}
                        onChange={(e) => {
                          const val = e.target.value;
                          const cursor = e.target.selectionStart ?? val.length;
                          setEditValue(val);
                          editUndo.record(val, cursor);
                          slashCmd.onEditValueChange(val, segWasBlankOnActivate.current);
                          // Auto-resize to fit wrapped content
                          e.target.style.height = "auto";
                          e.target.style.height = e.target.scrollHeight + "px";
                        }}
                        onBlur={handleBlur}
                        onMouseDown={() => {
                          dragAnchorSegRef.current = segIdx;
                        }}
                        onKeyDown={(e) => {
                          // When slash menu is open, let the hook handle keyboard
                          if (slashCmd.handleKeyDown(e)) {
                            e.preventDefault();
                            return;
                          }
                          if (isSingleLine) {
                            handleInputKeyDown(e, segIdx);
                          } else {
                            handleTextareaKeyDown(e, segIdx);
                          }
                        }}
                        onPaste={handlePaste}
                        placeholder={
                          isSingleLine && seg.type === "blank"
                            ? "Type / for commands..."
                            : undefined
                        }
                        spellCheck={false}
                        rows={isSingleLine ? 1 : seg.end - seg.start + 1}
                      />
                    ) : isComment ? (
                      <RenderedComment
                        key={`comment-${seg.start}-${commentEditCounter}`}
                        lines={lines.slice(seg.start, seg.end + 1)}
                        onResolve={() => resolveComment(segIdx)}
                        onReply={() => replyToComment(segIdx)}
                        onUpdate={(entryIdx, text) => updateComment(segIdx, entryIdx, text)}
                        autoEditLine={
                          pendingCommentEdit !== null &&
                          pendingCommentEdit >= seg.start &&
                          pendingCommentEdit <= seg.end + 1
                            ? pendingCommentEdit
                            : null
                        }
                        anchoredText={
                          anchorId
                            ? (() => {
                                let startLine = -1;
                                let endLine = -1;
                                for (let li = 0; li < lines.length; li++) {
                                  const t = lines[li].trim();
                                  if (COMMENT_START_RE.test(t) && t.includes(anchorId))
                                    startLine = li;
                                  if (COMMENT_END_RE.test(t) && t.includes(anchorId)) endLine = li;
                                }
                                if (startLine >= 0 && endLine > startLine) {
                                  return lines.slice(startLine + 1, endLine).join("\n");
                                }
                                return undefined;
                              })()
                            : undefined
                        }
                      />
                    ) : seg.type === "table" ? (
                      <InteractiveTable
                        lines={lines.slice(seg.start, seg.end + 1)}
                        parseInlineRich={parseInlineRich}
                        onUpdate={(newLines) => handleTableUpdate(seg, newLines)}
                      />
                    ) : (
                      <div
                        className="md-seg-rendered"
                        onClick={(e) => {
                          if (!(e.target instanceof HTMLElement)) return;
                          if (e.target.classList.contains("md-task-checkbox")) {
                            e.stopPropagation();
                            toggleTask(seg.start);
                          }
                        }}
                      >
                        {renderSegmentContent(seg, lines, filePath)}
                        {isCollapsed && (
                          <span
                            className="md-seg-collapsed-badge ml-2 inline-block cursor-pointer rounded-sm bg-muted/50 px-1.5 py-0.5 align-middle text-[0.7em] leading-none text-muted-foreground/70 transition-colors hover:bg-muted hover:text-muted-foreground"
                            title="Click to expand"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleCollapse(segIdx);
                            }}
                          >
                            …
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );

                if (!hasCtxMenu) return segDiv;

                return segDiv;
              })}
            </div>
            {/* Custom context menu (see useCreateContextMenu for why not Radix) */}
            {ctxMenu && (
              <div
                role="menu"
                aria-label="Text options"
                className="fixed z-50 min-w-[160px] animate-in rounded-md border border-border bg-popover p-1 shadow-md fade-in-0 zoom-in-95"
                style={{ left: ctxMenu.x, top: ctxMenu.y }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <button
                  role="menuitem"
                  className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    closeCtxMenu();
                    handleContextCut();
                  }}
                >
                  ✂️ Cut
                </button>
                <button
                  role="menuitem"
                  className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    closeCtxMenu();
                    handleContextCopy();
                  }}
                >
                  📋 Copy
                </button>
                <button
                  role="menuitem"
                  className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    closeCtxMenu();
                    void handleContextPaste();
                  }}
                >
                  📌 Paste
                </button>
                <div role="separator" className="my-1 h-px bg-border" />
                <button
                  role="menuitem"
                  className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    closeCtxMenu();
                    const info = contextInfoRef.current;
                    if (!info) return;
                    if (info.selEndSeg > info.selStartSeg) {
                      addComment(info.selEndSeg, info.selStartSeg, info.selEndSeg);
                    } else {
                      addComment(info.segIdx);
                    }
                  }}
                >
                  💬 Add Comment
                  <ShortcutKbd hotkey={window.platform === "darwin" ? "Meta+k" : "Control+k"} />
                </button>
              </div>
            )}
            <SlashCommandPicker
              isOpen={slashCmd.state.isOpen}
              items={slashCmd.filteredItems}
              selectedIndex={slashCmd.state.selectedIndex}
              anchorElement={slashAnchorEl}
              onSelect={handleSlashSelect}
              onHover={slashCmd.setSelectedIndex}
              onClose={slashCmd.close}
            />
          </>
        )}
        {supportsSourceMode && sourceMode && (
          <Suspense fallback={<div className="size-full" />}>
            <MonacoEditor
              testId="source-editor"
              language={monacoLanguageForFile(fileName)}
              theme={theme}
              value={content.content}
              onChange={handleEditorChange}
              onMount={(editor) => {
                monacoEditorRef.current = editor;
                applyToSource(editor);
                captureEditor(editor);
              }}
            />
          </Suspense>
        )}
        {content.type === "text" && (
          <Suspense fallback={<div className="size-full" />}>
            <MonacoEditor
              testId="text-editor"
              language={monacoLanguageForFile(fileName)}
              theme={theme}
              value={content.content}
              onChange={handleEditorChange}
              onMount={captureEditor}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
