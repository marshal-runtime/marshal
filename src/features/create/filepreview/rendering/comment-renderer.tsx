import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/marshal-ui/marshal-button";

import { COMMENT_RE } from "../markdownParser";

interface CommentEntry {
  kind: "comment" | "reply";
  text: string;
}

export function RenderedComment({
  lines,
  onResolve,
  onReply,
  onUpdate,
  autoEditLine,
  anchoredText,
}: {
  lines: string[];
  onResolve: () => void;
  onReply: () => void;
  onUpdate: (entryIdx: number, newText: string) => void;
  autoEditLine?: number | null;
  anchoredText?: string;
}) {
  const entries: CommentEntry[] = lines.map((l) => {
    const m = l.trim().match(COMMENT_RE);
    const rawKind = m?.[1];
    return {
      kind: rawKind === "comment" || rawKind === "reply" ? rawKind : "comment",
      text: m?.[3] ?? l,
    };
  });

  const [editingIdx, setEditingIdx] = useState<number | null>(() =>
    autoEditLine != null ? entries.length - 1 : null,
  );
  const [editText, setEditText] = useState(() =>
    autoEditLine != null ? (entries[entries.length - 1]?.text ?? "") : "",
  );
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editingIdx !== null) {
      requestAnimationFrame(() => editRef.current?.focus());
    }
  }, [editingIdx]);

  const saveEdit = () => {
    if (editingIdx !== null) {
      onUpdate(editingIdx, editText);
      setEditingIdx(null);
    }
  };

  const cancelEdit = () => {
    if (editingIdx !== null) {
      const entry = entries[editingIdx];
      if (entry && !entry.text.trim() && !editText.trim()) {
        onResolve();
        return;
      }
    }
    setEditingIdx(null);
    setEditText("");
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      saveEdit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  return (
    <div
      className="flex flex-col gap-1"
      data-testid="comment-thread"
      onClick={(e) => e.stopPropagation()}
    >
      {anchoredText && (
        <div className="mb-0.5 max-h-[4em] overflow-hidden rounded-sm border-l-2 border-l-primary bg-[rgba(255,255,255,0.03)] px-2 py-1 text-[11px] leading-[1.4] whitespace-pre-wrap text-muted-foreground">
          <span className="mr-1 font-semibold opacity-70">Re:</span>
          <span className="italic">{anchoredText}</span>
        </div>
      )}
      {entries.map((entry, i) => (
        <div
          // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
          key={`${entry.kind}-${i}-${entry.text.slice(0, 20)}`}
          className={`flex items-baseline gap-1.5 text-[12.5px] leading-normal${entry.kind === "reply" ? " pl-4" : ""}`}
        >
          <span className="shrink-0 text-[11px] opacity-70">
            {entry.kind === "reply" ? "↩" : "💬"}
          </span>
          {editingIdx === i ? (
            <div className="flex flex-1 flex-col gap-1">
              <textarea
                ref={editRef}
                className="field-sizing-content min-h-[1.5em] resize-none rounded-sm border border-[rgba(210,153,34,0.4)] bg-[rgba(255,255,255,0.06)] px-2 py-1 text-[12.5px] leading-normal text-foreground outline-none [font:inherit] focus:border-[#d29922]"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={handleEditKeyDown}
                rows={1}
                placeholder="Type your comment..."
              />
              <div className="flex gap-1">
                <Button size="sm" onClick={saveEdit}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelEdit}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <span
              className="cursor-pointer wrap-break-word text-foreground-secondary hover:text-foreground hover:underline hover:decoration-dotted hover:underline-offset-2"
              onClick={() => {
                setEditingIdx(i);
                setEditText(entry.text);
              }}
            >
              {entry.text || (
                <em className="text-muted-foreground italic opacity-70">Click to add text…</em>
              )}
            </span>
          )}
        </div>
      ))}
      {editingIdx === null && (
        <div className="flex gap-1.5 pt-1">
          <Button size="sm" variant="ghost" onClick={onReply} title="Reply">
            Reply
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onResolve}
            title="Resolve — removes comment from document"
          >
            ✓ Resolve
          </Button>
        </div>
      )}
    </div>
  );
}
