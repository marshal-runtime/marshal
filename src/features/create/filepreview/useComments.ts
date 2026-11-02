import { useCallback, useState } from "react";

import { useTimeout } from "@/runtime-ui/hooks/use-timeout";

import { COMMENT_END_RE, COMMENT_RE, COMMENT_START_RE, type Segment } from "./markdownParser";

// ── Types ──────────────────────────────────────────────────────
interface ContentMutators {
  undoStackPush: (value: string) => void;
  applyContent: (value: string) => void;
  debouncedSave: (value: string) => void;
}

interface UseCommentsParams {
  activeSegIdx: number | null;
  commitEdit: () => void;
  setActiveSegIdx: (idx: number | null) => void;
  clearHeightLock: () => void;
  segments: Segment[];
  lines: string[];
  content: ContentMutators;
}

// ── Hook ───────────────────────────────────────────────────────
export function useComments({
  activeSegIdx,
  commitEdit,
  setActiveSegIdx,
  clearHeightLock,
  segments,
  lines,
  content,
}: UseCommentsParams) {
  const { undoStackPush, applyContent, debouncedSave } = content;

  const [pendingCommentEdit, setPendingCommentEdit] = useState<number | null>(null);
  const [commentEditCounter, setCommentEditCounter] = useState(0);

  // Add a comment after a specific segment, optionally anchored to a range
  const addComment = useCallback(
    (afterSegIdx: number, anchorFromSeg?: number, anchorToSeg?: number) => {
      if (activeSegIdx !== null) commitEdit();
      const seg = segments[afterSegIdx];
      if (!seg) return;
      const newLines = [...lines];

      if (anchorFromSeg !== undefined && anchorToSeg !== undefined) {
        // Range-anchored comment: wrap selected segments with markers
        const id = Math.random().toString(36).slice(2, 8);
        const fromSeg = segments[anchorFromSeg];
        const toSeg = segments[anchorToSeg];
        if (!fromSeg || !toSeg) return;
        // Insert end marker + comment after the range, start marker before it
        const endLine = toSeg.end + 1;
        newLines.splice(endLine, 0, `<!-- @comment-end:${id} -->`, `<!-- @comment:${id}:  -->`);
        newLines.splice(fromSeg.start, 0, `<!-- @comment-start:${id} -->`);
        const newValue = newLines.join("\n");
        undoStackPush(newValue);
        applyContent(newValue);
        debouncedSave(newValue);
        setActiveSegIdx(null);
        clearHeightLock();
        // Comment line is at: fromSeg.start (start marker) + original range + end marker + 1
        setPendingCommentEdit(endLine + 2); // +1 for start marker, +1 for end marker line
        setCommentEditCounter((c) => c + 1);
      } else {
        // Simple comment after segment
        const insertAt = seg.end + 1;
        newLines.splice(insertAt, 0, "<!-- @comment:  -->");
        const newValue = newLines.join("\n");
        undoStackPush(newValue);
        applyContent(newValue);
        debouncedSave(newValue);
        setActiveSegIdx(null);
        clearHeightLock();
        setPendingCommentEdit(insertAt);
        setCommentEditCounter((c) => c + 1);
      }
    },
    [
      activeSegIdx,
      commitEdit,
      segments,
      lines,
      undoStackPush,
      applyContent,
      debouncedSave,
      setActiveSegIdx,
      clearHeightLock,
    ],
  );

  // Clear pending comment edit after render picks it up
  useTimeout(() => setPendingCommentEdit(null), pendingCommentEdit !== null ? 200 : null);

  // Resolve (delete) a comment thread
  const resolveComment = useCallback(
    (segIdx: number) => {
      const seg = segments[segIdx];
      if (!seg || seg.type !== "comment") return;
      const newLines = [...lines];

      // If anchored, also remove the start/end markers
      if (seg.anchorId) {
        // Remove lines from bottom to top to keep indices valid
        // Find end marker (should be the line just before the comment)
        // Find start marker (somewhere above)
        const linesToRemove: number[] = [];
        for (let i = seg.start; i <= seg.end; i++) linesToRemove.push(i); // comment lines
        for (let i = 0; i < newLines.length; i++) {
          const t = newLines[i].trim();
          if (COMMENT_START_RE.test(t) && t.includes(seg.anchorId)) linesToRemove.push(i);
          if (COMMENT_END_RE.test(t) && t.includes(seg.anchorId)) linesToRemove.push(i);
        }
        // Remove in reverse order
        linesToRemove.sort((a, b) => b - a);
        for (const idx of linesToRemove) newLines.splice(idx, 1);
      } else {
        newLines.splice(seg.start, seg.end - seg.start + 1);
      }

      if (newLines.length === 0) newLines.push("");
      const newValue = newLines.join("\n");
      undoStackPush(newValue);
      applyContent(newValue);
      debouncedSave(newValue);
    },
    [segments, lines, undoStackPush, applyContent, debouncedSave],
  );

  // Reply to a comment thread
  const replyToComment = useCallback(
    (segIdx: number) => {
      const seg = segments[segIdx];
      if (!seg || seg.type !== "comment") return;
      const insertAt = seg.end + 1;
      const newLines = [...lines];
      newLines.splice(insertAt, 0, "<!-- @reply:  -->");
      const newValue = newLines.join("\n");
      undoStackPush(newValue);
      applyContent(newValue);
      debouncedSave(newValue);
      // Signal RenderedComment to auto-edit the new reply
      setPendingCommentEdit(insertAt);
      setCommentEditCounter((c) => c + 1);
    },
    [segments, lines, undoStackPush, applyContent, debouncedSave],
  );

  // Update a single comment/reply entry text
  const updateComment = useCallback(
    (segIdx: number, entryIdx: number, newText: string) => {
      const seg = segments[segIdx];
      if (!seg || seg.type !== "comment") return;
      const entryLine = seg.start + entryIdx;
      const oldLine = lines[entryLine]?.trim() ?? "";
      const m = oldLine.match(COMMENT_RE);
      const kind = m?.[1] || "comment";
      const anchorId = m?.[2] || seg.anchorId;
      const newLines = [...lines];
      newLines[entryLine] = anchorId
        ? `<!-- @${kind}:${anchorId}: ${newText} -->`
        : `<!-- @${kind}: ${newText} -->`;
      const newValue = newLines.join("\n");
      undoStackPush(newValue);
      applyContent(newValue);
      debouncedSave(newValue);
    },
    [segments, lines, undoStackPush, applyContent, debouncedSave],
  );

  return {
    pendingCommentEdit,
    commentEditCounter,
    addComment,
    resolveComment,
    replyToComment,
    updateComment,
  };
}
