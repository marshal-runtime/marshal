/**
 * Built-in generic "data-table" component for runtimeShowUi. Self-contained:
 * no imports besides React (the authoring profile's marshal-standards
 * default disallows any other bare package import). Phone-first: the table
 * scrolls horizontally instead of overflowing, and the filter/caption stack
 * vertically on narrow viewports.
 */
import { useMemo, useState } from "react";

type Align = "left" | "center" | "right";

interface DataTableColumn {
  key: string;
  label: string;
  align?: Align;
}

type DataTableRow = Record<string, unknown>;

interface DataTableProps {
  columns: DataTableColumn[];
  rows: DataTableRow[];
  caption?: string;
  sortable?: boolean;
}

const MAX_RENDERED_ROWS = 500;

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

export default function DataTable(props: DataTableProps) {
  const { columns, rows, caption, sortable } = props;
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: string; direction: "asc" | "desc" } | null>(null);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      columns.some((column) => cellText(row[column.key]).toLowerCase().includes(needle)),
    );
  }, [rows, columns, filter]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const { key, direction } = sort;
    const copy = [...filtered];
    copy.sort((a, b) => {
      const left = cellText(a[key]);
      const right = cellText(b[key]);
      const numericLeft = Number(left);
      const numericRight = Number(right);
      const comparison =
        Number.isFinite(numericLeft) && Number.isFinite(numericRight) && left !== "" && right !== ""
          ? numericLeft - numericRight
          : left.localeCompare(right);
      return direction === "asc" ? comparison : -comparison;
    });
    return copy;
  }, [filtered, sort]);

  const visible = sorted.slice(0, MAX_RENDERED_ROWS);
  const truncated = sorted.length > visible.length;

  const toggleSort = (key: string) => {
    if (!sortable) return;
    setSort((current) => {
      if (!current || current.key !== key) return { key, direction: "asc" };
      if (current.direction === "asc") return { key, direction: "desc" };
      return null;
    });
  };

  return (
    <div
      style={{
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        color: "var(--color-text-primary, #171717)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
      }}
    >
      <style>{`
        .rt-dt-input{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;
          border:1px solid color-mix(in srgb, currentColor 20%, transparent);
          background:var(--color-background-secondary,#f2f2f2);color:inherit;font:inherit}
        .rt-dt-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
        .rt-dt-table{border-collapse:collapse;width:100%;min-width:320px;font-size:13px}
        .rt-dt-table th,.rt-dt-table td{padding:8px 10px;text-align:left;
          border-bottom:1px solid color-mix(in srgb, currentColor 12%, transparent);
          white-space:nowrap}
        .rt-dt-table th{color:var(--color-text-secondary,#666);font-weight:600;cursor:default}
        .rt-dt-table th button{all:unset;cursor:pointer;display:inline-flex;gap:4px;align-items:center}
        .rt-dt-note{font-size:12px;color:var(--color-text-secondary,#666)}
      `}</style>
      {caption ? <div style={{ fontWeight: 600 }}>{caption}</div> : null}
      <input
        type="text"
        className="rt-dt-input"
        placeholder="Filter rows"
        aria-label="Filter table rows"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="rt-dt-scroll">
        <table className="rt-dt-table" aria-label={caption ?? "Data table"}>
          {caption ? <caption style={{ display: "none" }}>{caption}</caption> : null}
          <thead>
            <tr>
              {columns.map((column) => {
                const active = sort?.key === column.key;
                const ariaSort = active
                  ? sort?.direction === "asc"
                    ? "ascending"
                    : "descending"
                  : "none";
                return (
                  <th
                    key={column.key}
                    scope="col"
                    style={{ textAlign: column.align ?? "left" }}
                    aria-sort={sortable ? ariaSort : undefined}
                  >
                    {sortable ? (
                      <button type="button" onClick={() => toggleSort(column.key)}>
                        {column.label}
                        {active ? (sort?.direction === "asc" ? " ↑" : " ↓") : ""}
                      </button>
                    ) : (
                      column.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => (
              // eslint-disable-next-line react/no-array-index-key -- rows carry no identity; cells are stateless
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column.key} style={{ textAlign: column.align ?? "left" }}>
                    {cellText(row[column.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? <p className="rt-dt-note">No rows.</p> : null}
      {truncated || rows.length !== sorted.length ? (
        <p className="rt-dt-note">
          Showing {visible.length} of {sorted.length} row{sorted.length === 1 ? "" : "s"}
          {sorted.length !== rows.length ? ` (filtered from ${rows.length})` : ""}.
        </p>
      ) : null}
    </div>
  );
}
