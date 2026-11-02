import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { useCreateContextMenu } from "./hooks/useCreateContextMenu";

// ── Types ──────────────────────────────────────────────────────
interface InteractiveTableProps {
  lines: string[]; // raw markdown lines (header, separator, data rows)
  parseInlineRich: (text: string) => ReactNode;
  onUpdate: (newLines: string[]) => void; // callback to commit changes
}

interface CellPos {
  row: number; // -1 = header
  col: number;
}

interface CtxInfo {
  row: number; // -1 = header row
  col: number; // -1 = row handle
}

// ── Helpers ────────────────────────────────────────────────────
const TABLE_ROW_RE = /^\|(.+)\|$/;

function parseCells(line: string): string[] {
  const m = line.match(TABLE_ROW_RE);
  if (!m) return [];
  return m[1].split("|").map((c) => c.trim());
}

function buildRow(cells: string[]): string {
  return "| " + cells.join(" | ") + " |";
}

function buildSeparator(colCount: number, alignments: string[]): string {
  const cols = Array.from({ length: colCount }, (_, i) => {
    const a = alignments[i] ?? "---";
    return a;
  });
  return "| " + cols.join(" | ") + " |";
}

function parseAlignments(sepLine: string): string[] {
  const m = sepLine.match(TABLE_ROW_RE);
  if (!m) return [];
  return m[1].split("|").map((c) => c.trim());
}

function getTextAlign(alignment: string): "left" | "center" | "right" {
  const l = alignment.startsWith(":");
  const r = alignment.endsWith(":");
  if (l && r) return "center";
  if (r) return "right";
  return "left";
}

// Shared button class for context menu items
const CTX_ITEM_CLASS =
  "flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground";
const CTX_ITEM_DESTRUCTIVE_CLASS =
  "flex w-full items-center rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10 hover:text-destructive";
const CTX_ITEM_DISABLED_CLASS =
  "flex w-full items-center rounded-sm px-2 py-1.5 text-sm text-muted-foreground pointer-events-none opacity-50";

// ── Component ──────────────────────────────────────────────────
export function InteractiveTable({ lines, parseInlineRich, onUpdate }: InteractiveTableProps) {
  const headerCells = parseCells(lines[0]);
  const alignments = parseAlignments(lines[1]);
  const dataRows = lines.slice(2).map(parseCells);
  const colCount = headerCells.length;

  // Editing state
  const [editCell, setEditCell] = useState<CellPos | null>(null);
  const [editValue, setEditValue] = useState("");
  const editRef = useRef<HTMLInputElement>(null);

  // Context menu (custom div, not Radix — see useCreateContextMenu for why)
  const { menu: ctxPos, open: openCtxMenu, closeAndRun: ctxAction } = useCreateContextMenu();
  const [ctxInfo, setCtxInfo] = useState<CtxInfo | null>(null);
  const ctxMenu = ctxPos && ctxInfo ? { ...ctxPos, info: ctxInfo } : null;

  // Drag state
  const [dragCol, setDragCol] = useState<number | null>(null);
  const [dragRow, setDragRow] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  // Lock column widths when editing to prevent table reflow
  const [colWidths, setColWidths] = useState<number[] | null>(null);

  // Focus input on edit
  useEffect(() => {
    if (editCell) {
      requestAnimationFrame(() => {
        const el = editRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    }
  }, [editCell]);

  // ── Cell Editing ──────────────────────────────────────────────
  const startEdit = useCallback(
    (row: number, col: number) => {
      const cells = row === -1 ? headerCells : dataRows[row];
      const value = cells?.[col] ?? "";
      // Lock column widths before switching to input to prevent reflow
      if (!colWidths && tableRef.current) {
        const headerCellEls = tableRef.current.querySelectorAll(
          "thead tr:last-child th[data-cell]",
        );
        if (headerCellEls.length > 0) {
          setColWidths(Array.from(headerCellEls).map((el) => el.getBoundingClientRect().width));
        }
      }
      setEditValue(value);
      setEditCell({ row, col });
    },
    [headerCells, dataRows, colWidths],
  );

  const commitCell = useCallback(() => {
    if (!editCell) return;
    const { row, col } = editCell;
    const newLines = [...lines];

    if (row === -1) {
      // Header
      const cells = parseCells(newLines[0]);
      cells[col] = editValue;
      newLines[0] = buildRow(cells);
    } else {
      const lineIdx = row + 2; // skip header + separator
      const cells = parseCells(newLines[lineIdx]);
      cells[col] = editValue;
      newLines[lineIdx] = buildRow(cells);
    }

    setEditCell(null);
    // Don't clear colWidths here — keyboard navigation calls commitCell then
    // startEdit immediately, and clearing causes a 1-frame reflow. Widths are
    // cleared in deactivateCell (Escape / blur without re-entry).
    onUpdate(newLines);
  }, [editCell, editValue, lines, onUpdate]);

  // Fully exit editing mode (clear widths lock)
  const deactivateCell = useCallback(() => {
    setEditCell(null);
    setColWidths(null);
  }, []);

  const handleCellKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!editCell) return;
      const input = e.currentTarget;

      if (e.key === "Escape") {
        e.preventDefault();
        deactivateCell();
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        commitCell();
        // Move to cell below
        requestAnimationFrame(() => {
          const nextRow = editCell.row + 1;
          if (nextRow < dataRows.length) {
            startEdit(nextRow, editCell.col);
          }
        });
        return;
      }

      if (e.key === "Tab") {
        e.preventDefault();
        commitCell();
        // Move to next cell
        requestAnimationFrame(() => {
          const nextCol = editCell.col + (e.shiftKey ? -1 : 1);
          if (nextCol >= 0 && nextCol < colCount) {
            startEdit(editCell.row, nextCol);
          } else if (!e.shiftKey && nextCol >= colCount && editCell.row + 1 < dataRows.length) {
            startEdit(editCell.row + 1, 0);
          } else if (e.shiftKey && nextCol < 0 && editCell.row > -1) {
            startEdit(editCell.row - 1, colCount - 1);
          }
        });
        return;
      }

      // ArrowUp → move to cell above
      if (e.key === "ArrowUp" && !e.shiftKey) {
        const prevRow = editCell.row - 1;
        if (prevRow >= -1) {
          e.preventDefault();
          commitCell();
          requestAnimationFrame(() => startEdit(prevRow, editCell.col));
        }
        return;
      }

      // ArrowDown → move to cell below
      if (e.key === "ArrowDown" && !e.shiftKey) {
        const nextRow = editCell.row + 1;
        if (nextRow < dataRows.length) {
          e.preventDefault();
          commitCell();
          requestAnimationFrame(() => startEdit(nextRow, editCell.col));
        }
        return;
      }

      // ArrowLeft at position 0 → move to previous cell (end)
      if (
        e.key === "ArrowLeft" &&
        !e.shiftKey &&
        input.selectionStart === 0 &&
        input.selectionStart === input.selectionEnd
      ) {
        const prevCol = editCell.col - 1;
        if (prevCol >= 0) {
          e.preventDefault();
          commitCell();
          requestAnimationFrame(() => startEdit(editCell.row, prevCol));
        } else if (editCell.row > -1) {
          e.preventDefault();
          commitCell();
          requestAnimationFrame(() => startEdit(editCell.row - 1, colCount - 1));
        }
        return;
      }

      // ArrowRight at end → move to next cell (start)
      if (
        e.key === "ArrowRight" &&
        !e.shiftKey &&
        input.selectionEnd === input.value.length &&
        input.selectionStart === input.selectionEnd
      ) {
        const nextCol = editCell.col + 1;
        if (nextCol < colCount) {
          e.preventDefault();
          commitCell();
          requestAnimationFrame(() => startEdit(editCell.row, nextCol));
        } else if (editCell.row + 1 < dataRows.length) {
          e.preventDefault();
          commitCell();
          requestAnimationFrame(() => startEdit(editCell.row + 1, 0));
        }
        return;
      }
    },
    [editCell, commitCell, deactivateCell, startEdit, colCount, dataRows.length],
  );

  // ── Structural Operations ─────────────────────────────────────
  const insertColumn = useCallback(
    (afterCol: number) => {
      const newLines = lines.map((line, idx) => {
        const cells = parseCells(line);
        if (idx === 1) {
          // Separator
          const aligns = parseAlignments(line);
          aligns.splice(afterCol + 1, 0, "---");
          return buildSeparator(aligns.length, aligns);
        }
        cells.splice(afterCol + 1, 0, idx === 0 ? "Header" : "");
        return buildRow(cells);
      });
      onUpdate(newLines);
    },
    [lines, onUpdate],
  );

  const insertColumnBefore = useCallback(
    (beforeCol: number) => {
      const newLines = lines.map((line, idx) => {
        const cells = parseCells(line);
        if (idx === 1) {
          const aligns = parseAlignments(line);
          aligns.splice(beforeCol, 0, "---");
          return buildSeparator(aligns.length, aligns);
        }
        cells.splice(beforeCol, 0, idx === 0 ? "Header" : "");
        return buildRow(cells);
      });
      onUpdate(newLines);
    },
    [lines, onUpdate],
  );

  const deleteColumn = useCallback(
    (col: number) => {
      if (colCount <= 1) return; // don't delete last column
      const newLines = lines.map((line, idx) => {
        const cells = parseCells(line);
        if (idx === 1) {
          const aligns = parseAlignments(line);
          aligns.splice(col, 1);
          return buildSeparator(aligns.length, aligns);
        }
        cells.splice(col, 1);
        return buildRow(cells);
      });
      onUpdate(newLines);
    },
    [lines, colCount, onUpdate],
  );

  const insertRowAfter = useCallback(
    (afterRow: number) => {
      const newLines = [...lines];
      const emptyCells = Array(colCount).fill("");
      const lineIdx = afterRow + 2 + 1; // header(0) + sep(1) + afterRow + 1
      newLines.splice(lineIdx, 0, buildRow(emptyCells));
      onUpdate(newLines);
    },
    [lines, colCount, onUpdate],
  );

  const insertRowBefore = useCallback(
    (beforeRow: number) => {
      const newLines = [...lines];
      const emptyCells = Array(colCount).fill("");
      const lineIdx = beforeRow + 2; // header(0) + sep(1) + beforeRow
      newLines.splice(lineIdx, 0, buildRow(emptyCells));
      onUpdate(newLines);
    },
    [lines, colCount, onUpdate],
  );

  const deleteRow = useCallback(
    (row: number) => {
      if (dataRows.length <= 1) return; // keep at least one row
      const newLines = [...lines];
      newLines.splice(row + 2, 1);
      onUpdate(newLines);
    },
    [lines, dataRows.length, onUpdate],
  );

  const addRowAtEnd = useCallback(() => {
    const newLines = [...lines];
    const emptyCells = Array(colCount).fill("");
    newLines.push(buildRow(emptyCells));
    onUpdate(newLines);
  }, [lines, colCount, onUpdate]);

  const addColumnAtEnd = useCallback(() => {
    insertColumn(colCount - 1);
  }, [insertColumn, colCount]);

  // ── Column Drag & Drop ────────────────────────────────────────
  const handleColDragStart = useCallback((col: number, e: React.DragEvent) => {
    setDragCol(col);
    setDragRow(null);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(col));
  }, []);

  const handleColDragOver = useCallback(
    (col: number, e: React.DragEvent) => {
      if (dragCol === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropTarget(col);
    },
    [dragCol],
  );

  const handleColDrop = useCallback(
    (targetCol: number) => {
      if (dragCol === null || dragCol === targetCol) {
        setDragCol(null);
        setDropTarget(null);
        return;
      }
      // Swap columns
      const newLines = lines.map((line, idx) => {
        if (idx === 1) {
          const aligns = parseAlignments(line);
          const [removed] = aligns.splice(dragCol, 1);
          aligns.splice(targetCol, 0, removed);
          return buildSeparator(aligns.length, aligns);
        }
        const cells = parseCells(line);
        const [removed] = cells.splice(dragCol, 1);
        cells.splice(targetCol, 0, removed);
        return buildRow(cells);
      });
      setDragCol(null);
      setDropTarget(null);
      onUpdate(newLines);
    },
    [dragCol, lines, onUpdate],
  );

  // ── Row Drag & Drop ───────────────────────────────────────────
  const handleRowDragStart = useCallback((row: number, e: React.DragEvent) => {
    setDragRow(row);
    setDragCol(null);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(row));
  }, []);

  const handleRowDragOver = useCallback(
    (row: number, e: React.DragEvent) => {
      if (dragRow === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropTarget(row);
    },
    [dragRow],
  );

  const handleRowDrop = useCallback(
    (targetRow: number) => {
      if (dragRow === null || dragRow === targetRow) {
        setDragRow(null);
        setDropTarget(null);
        return;
      }
      const newLines = [...lines];
      const srcIdx = dragRow + 2;
      const tgtIdx = targetRow + 2;
      const [removed] = newLines.splice(srcIdx, 1);
      newLines.splice(tgtIdx, 0, removed);
      setDragRow(null);
      setDropTarget(null);
      onUpdate(newLines);
    },
    [dragRow, lines, onUpdate],
  );

  const handleDragEnd = useCallback(() => {
    setDragCol(null);
    setDragRow(null);
    setDropTarget(null);
  }, []);

  // ── Context Menu ──────────────────────────────────────────────
  const handleContextMenu = useCallback(
    (row: number, col: number, e: React.MouseEvent) => {
      setCtxInfo({ row, col });
      openCtxMenu(e);
    },
    [openCtxMenu],
  );

  // ── Render ────────────────────────────────────────────────────
  const renderCell = (
    content: string,
    row: number,
    col: number,
    Tag: "th" | "td",
    align: "left" | "center" | "right",
  ) => {
    const isEditing = editCell?.row === row && editCell?.col === col;
    const isDropCol = dragCol !== null && dropTarget === col;
    const isDropRow = dragRow !== null && dropTarget === row;

    return (
      <Tag
        key={col}
        data-cell
        className={`relative min-w-[60px] cursor-text border border-border px-2.5 py-1.5 text-left hover:bg-[rgba(124,92,191,0.10)]${Tag === "th" ? " bg-muted font-semibold" : ""}${isDropCol ? " border-l-2 border-l-(--color-accent,#7c5cbf)" : ""}${isDropRow ? " border-t-2 border-t-(--color-accent,#7c5cbf)" : ""}`}
        style={{ textAlign: align }}
        onClick={(e) => {
          e.stopPropagation();
          if (!isEditing) startEdit(row, col);
        }}
        onDragOver={(e) => {
          if (dragCol !== null) handleColDragOver(col, e);
          if (dragRow !== null) handleRowDragOver(row === -1 ? 0 : row, e);
        }}
        onDrop={() => {
          if (dragCol !== null) handleColDrop(col);
          if (dragRow !== null) handleRowDrop(row === -1 ? 0 : row);
        }}
        onContextMenu={(e) => handleContextMenu(row, col, e)}
      >
        {isEditing ? (
          <input
            ref={editRef}
            className="m-0 w-full border-none bg-transparent p-0 text-inherit outline-none [font:inherit]"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={() => {
              commitCell();
              // Clear column width lock after a microtask — if startEdit runs
              // synchronously (keyboard nav), colWidths will be preserved. If not
              // (clicked outside), they'll be cleared.
              setTimeout(() => {
                setColWidths((prev) => prev);
                // If no cell is active after the microtask, clear widths
                setEditCell((current) => {
                  if (current === null) setColWidths(null);
                  return current;
                });
              }, 0);
            }}
            onKeyDown={handleCellKeyDown}
            spellCheck={false}
          />
        ) : (
          parseInlineRich(content)
        )}
      </Tag>
    );
  };

  return (
    <div
      ref={tableRef}
      className="group relative my-[0.3em] overflow-x-auto"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDragEnd={handleDragEnd}
    >
      <table className="w-auto min-w-full border-collapse text-[13px]">
        {/* Column drag handles */}
        <colgroup>
          <col className="w-7" />
          {headerCells.map((_, ci) => (
            // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
            <col key={ci} style={colWidths?.[ci] ? { width: colWidths[ci] } : undefined} />
          ))}
          <col className="w-7" />
        </colgroup>

        <thead>
          {/* Column handles row */}
          <tr className="opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            <th className="h-5 border-none bg-transparent p-0 text-center text-[10px] text-(--text-tertiary,#888)" />
            {headerCells.map((_, ci) => (
              <th
                // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
                key={ci}
                className={`h-5 cursor-grab rounded-t-[3px] border-none bg-transparent p-0 text-center text-[10px] text-(--text-tertiary,#888) select-none hover:bg-[rgba(124,92,191,0.15)] hover:text-foreground${dragCol === ci ? " opacity-40" : ""}${dropTarget === ci && dragCol !== null ? " bg-(--color-accent,#7c5cbf)! text-white!" : ""}`}
                draggable
                onDragStart={(e) => handleColDragStart(ci, e)}
                onDragOver={(e) => handleColDragOver(ci, e)}
                onDrop={() => handleColDrop(ci)}
                onContextMenu={(e) => handleContextMenu(-1, ci, e)}
                title="Drag to reorder column"
              >
                <span className="pointer-events-none text-[9px] tracking-[-2px]">⋮⋮</span>
              </th>
            ))}
            <th
              data-add-col
              className="h-5 cursor-pointer border-none bg-transparent px-1 text-center align-middle text-base font-semibold text-(--text-tertiary,#888) opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:bg-[rgba(124,92,191,0.15)] hover:text-foreground"
              onClick={addColumnAtEnd}
              title="Add column"
            >
              +
            </th>
          </tr>

          {/* Header row */}
          <tr>
            <th
              className="w-7 max-w-7 cursor-default border-none bg-transparent p-0.5 text-center align-middle text-(--text-tertiary,#888) opacity-0 transition-opacity duration-150 select-none group-hover:opacity-100 hover:bg-[rgba(124,92,191,0.15)] hover:text-foreground"
              onContextMenu={(e) => handleContextMenu(-1, -1, e)}
            >
              <span className="pointer-events-none inline-block rotate-90 text-[9px] tracking-[-2px]">
                ⋮⋮
              </span>
            </th>
            {headerCells.map((cell, ci) =>
              renderCell(cell, -1, ci, "th", getTextAlign(alignments[ci] ?? "---")),
            )}
            <th className="w-7 border-none bg-transparent p-0" />
          </tr>
        </thead>

        <tbody>
          {dataRows.map((row, ri) => (
            <tr
              // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
              key={ri}
              className={`${dragRow === ri ? "opacity-40" : ""}${dropTarget === ri && dragRow !== null ? " md-it-drop-row-target" : ""}`}
            >
              <td
                className="w-7 max-w-7 cursor-grab border-none bg-transparent p-0.5 text-center align-middle text-(--text-tertiary,#888) opacity-0 transition-opacity duration-150 select-none group-hover:opacity-100 hover:bg-[rgba(124,92,191,0.15)] hover:text-foreground"
                draggable
                onDragStart={(e) => handleRowDragStart(ri, e)}
                onDragOver={(e) => handleRowDragOver(ri, e)}
                onDrop={() => handleRowDrop(ri)}
                onContextMenu={(e) => handleContextMenu(ri, -1, e)}
                title="Drag to reorder row"
              >
                <span className="pointer-events-none inline-block rotate-90 text-[9px] tracking-[-2px]">
                  ⋮⋮
                </span>
              </td>
              {row.map((cell, ci) =>
                renderCell(cell, ri, ci, "td", getTextAlign(alignments[ci] ?? "---")),
              )}
              <td className="w-7 border-none bg-transparent p-0" />
            </tr>
          ))}

          {/* Add row button */}
          <tr className="opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            <td className="border-none px-0 py-1" />
            <td
              colSpan={colCount}
              className="cursor-pointer rounded-sm border border-dashed border-border px-2.5 py-1 text-center text-xs text-(--text-tertiary,#888) hover:border-(--color-accent,#7c5cbf) hover:bg-[rgba(124,92,191,0.12)] hover:text-foreground"
              onClick={addRowAtEnd}
            >
              + Add row
            </td>
            <td className="border-none px-0 py-1" />
          </tr>
        </tbody>
      </table>

      {/* Custom context menu (see useCreateContextMenu for why not Radix) */}
      {ctxMenu && (
        <div
          role="menu"
          aria-label="Table options"
          className="fixed z-50 min-w-[160px] animate-in rounded-md border border-border bg-popover p-1 shadow-md fade-in-0 zoom-in-95"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {ctxMenu.info.col >= 0 && (
            <>
              <button
                role="menuitem"
                className={CTX_ITEM_CLASS}
                onClick={ctxAction(() => insertColumnBefore(ctxMenu.info.col))}
              >
                ← Insert column left
              </button>
              <button
                role="menuitem"
                className={CTX_ITEM_CLASS}
                onClick={ctxAction(() => insertColumn(ctxMenu.info.col))}
              >
                → Insert column right
              </button>
              <button
                role="menuitem"
                className={colCount <= 1 ? CTX_ITEM_DISABLED_CLASS : CTX_ITEM_DESTRUCTIVE_CLASS}
                disabled={colCount <= 1}
                onClick={ctxAction(() => deleteColumn(ctxMenu.info.col))}
              >
                ✕ Delete column
              </button>
              {ctxMenu.info.row >= 0 && <div role="separator" className="my-1 h-px bg-border" />}
            </>
          )}
          {ctxMenu.info.row >= 0 && (
            <>
              <button
                role="menuitem"
                className={CTX_ITEM_CLASS}
                onClick={ctxAction(() => insertRowBefore(ctxMenu.info.row))}
              >
                ↑ Insert row above
              </button>
              <button
                role="menuitem"
                className={CTX_ITEM_CLASS}
                onClick={ctxAction(() => insertRowAfter(ctxMenu.info.row))}
              >
                ↓ Insert row below
              </button>
              <button
                role="menuitem"
                className={
                  dataRows.length <= 1 ? CTX_ITEM_DISABLED_CLASS : CTX_ITEM_DESTRUCTIVE_CLASS
                }
                disabled={dataRows.length <= 1}
                onClick={ctxAction(() => deleteRow(ctxMenu.info.row))}
              >
                ✕ Delete row
              </button>
            </>
          )}
          {ctxMenu.info.row === -1 && ctxMenu.info.col === -1 && (
            <>
              <button role="menuitem" className={CTX_ITEM_CLASS} onClick={ctxAction(addRowAtEnd)}>
                + Add row at end
              </button>
              <button
                role="menuitem"
                className={CTX_ITEM_CLASS}
                onClick={ctxAction(addColumnAtEnd)}
              >
                + Add column at end
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
