/**
 * Built-in generic "key-value" component for runtimeShowUi — a status/summary
 * card. Self-contained: no imports besides React.
 */
type Tone = "neutral" | "positive" | "negative" | "warning";

interface KeyValueItem {
  label: string;
  value: string | number | boolean;
  tone?: Tone;
}

interface KeyValueProps {
  title?: string;
  items: KeyValueItem[];
}

const TONE_COLOR: Record<Tone, string> = {
  neutral: "var(--color-text-primary, #171717)",
  positive: "#1a7f37",
  negative: "var(--color-text-danger, #b42318)",
  warning: "#9a6700",
};

export default function KeyValue(props: KeyValueProps) {
  const { title, items } = props;
  return (
    <div
      style={{
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        color: "var(--color-text-primary, #171717)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 12,
        borderRadius: 10,
        background: "var(--color-background-secondary, #f2f2f2)",
      }}
    >
      {title ? <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{title}</h2> : null}
      {items.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--color-text-secondary, #666)" }}>
          Nothing to show.
        </p>
      ) : (
        <dl
          style={{
            margin: 0,
            display: "grid",
            gridTemplateColumns: "minmax(0,1fr)",
            rowGap: 8,
          }}
        >
          {items.map((item) => (
            <div
              key={item.label}
              style={{
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "space-between",
                gap: 8,
                borderBottom: "1px solid color-mix(in srgb, currentColor 10%, transparent)",
                paddingBottom: 6,
              }}
            >
              <dt style={{ fontSize: 12, color: "var(--color-text-secondary, #666)" }}>
                {item.label}
              </dt>
              <dd
                style={{
                  margin: 0,
                  fontSize: 13,
                  fontWeight: 600,
                  color: TONE_COLOR[item.tone ?? "neutral"],
                  textAlign: "right",
                  wordBreak: "break-word",
                }}
              >
                {String(item.value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
