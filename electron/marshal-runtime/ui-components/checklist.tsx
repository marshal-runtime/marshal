/**
 * Built-in generic "checklist" component for runtimeShowUi — a progress
 * board. Self-contained: no imports besides React.
 */
type ChecklistStatus = "todo" | "doing" | "done" | "blocked";

interface ChecklistItem {
  id: string;
  label: string;
  status: ChecklistStatus;
  detail?: string;
}

interface ChecklistProps {
  items: ChecklistItem[];
}

const STATUS_LABEL: Record<ChecklistStatus, string> = {
  todo: "To do",
  doing: "In progress",
  done: "Done",
  blocked: "Blocked",
};

const STATUS_COLOR: Record<ChecklistStatus, string> = {
  todo: "var(--color-text-secondary, #666)",
  doing: "var(--color-ring, #2563eb)",
  done: "#1a7f37",
  blocked: "var(--color-text-danger, #b42318)",
};

const STATUS_GLYPH: Record<ChecklistStatus, string> = {
  todo: "○",
  doing: "◐",
  done: "●",
  blocked: "✕",
};

export default function Checklist(props: ChecklistProps) {
  const { items } = props;
  const done = items.filter((item) => item.status === "done").length;
  return (
    <div
      style={{
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        color: "var(--color-text-primary, #171717)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 12,
      }}
    >
      <header
        style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}
      >
        <span style={{ fontWeight: 600, fontSize: 14 }}>Checklist</span>
        <span style={{ fontSize: 12, color: "var(--color-text-secondary, #666)" }}>
          {done}/{items.length} done
        </span>
      </header>
      {items.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--color-text-secondary, #666)" }}>
          No items.
        </p>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {items.map((item) => (
            <li
              key={item.id}
              role="status"
              aria-label={`${item.label}: ${STATUS_LABEL[item.status]}`}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
                padding: "8px 10px",
                borderRadius: 8,
                background: "var(--color-background-secondary, #f2f2f2)",
              }}
            >
              <span
                aria-hidden="true"
                style={{ color: STATUS_COLOR[item.status], fontSize: 16, lineHeight: "20px" }}
              >
                {STATUS_GLYPH[item.status]}
              </span>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 500, wordBreak: "break-word" }}>
                  {item.label}
                </span>
                <span style={{ fontSize: 11, color: STATUS_COLOR[item.status] }}>
                  {STATUS_LABEL[item.status]}
                </span>
                {item.detail ? (
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--color-text-secondary, #666)",
                      wordBreak: "break-word",
                    }}
                  >
                    {item.detail}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
