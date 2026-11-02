/**
 * Built-in generic "diff-list" component for runtimeShowUi — a collapsed
 * per-file diff summary that expands to hunks. Self-contained: no imports
 * besides React.
 */
interface DiffHunk {
  header: string;
  lines: string[];
}

interface DiffFile {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
  hunks?: DiffHunk[];
}

interface DiffListProps {
  files: DiffFile[];
}

function lineColor(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "#1a7f37";
  if (line.startsWith("-") && !line.startsWith("---")) return "var(--color-text-danger, #b42318)";
  return "var(--color-text-secondary, #666)";
}

export default function DiffList(props: DiffListProps) {
  const { files } = props;
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
        .rt-dl-details{border-radius:8px;background:var(--color-background-secondary,#f2f2f2);overflow:hidden}
        .rt-dl-summary{cursor:pointer;list-style:none;display:flex;gap:8px;align-items:center;
          justify-content:space-between;padding:8px 10px;font-size:13px}
        .rt-dl-summary::-webkit-details-marker{display:none}
        .rt-dl-hunk{margin:0 10px 10px;border-radius:6px;background:color-mix(in srgb, currentColor 6%, transparent);
          padding:8px;overflow-x:auto}
        .rt-dl-hunk-header{font-size:11px;color:var(--color-text-secondary,#666);margin:0 0 4px}
        .rt-dl-line{white-space:pre;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;margin:0}
      `}</style>
      {files.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--color-text-secondary, #666)" }}>
          No file changes.
        </p>
      ) : (
        files.map((file) => (
          <details key={file.path} className="rt-dl-details">
            <summary className="rt-dl-summary">
              <span style={{ fontWeight: 500, wordBreak: "break-all" }}>{file.path}</span>
              <span
                style={{
                  fontSize: 11,
                  color: "var(--color-text-secondary, #666)",
                  display: "flex",
                  gap: 6,
                  flexShrink: 0,
                }}
              >
                <span>{file.status}</span>
                {typeof file.additions === "number" ? (
                  <span style={{ color: "#1a7f37" }}>+{file.additions}</span>
                ) : null}
                {typeof file.deletions === "number" ? (
                  <span style={{ color: "var(--color-text-danger, #b42318)" }}>
                    -{file.deletions}
                  </span>
                ) : null}
              </span>
            </summary>
            {(file.hunks ?? []).map((hunk, index) => (
              // eslint-disable-next-line react/no-array-index-key -- hunks have no identity beyond position
              <div className="rt-dl-hunk" key={`${file.path}:${index}`}>
                <p className="rt-dl-hunk-header">{hunk.header}</p>
                {hunk.lines.map((line, lineIndex) => (
                  // eslint-disable-next-line react/no-array-index-key -- diff lines repeat; position is the identity
                  <p className="rt-dl-line" key={lineIndex} style={{ color: lineColor(line) }}>
                    {line}
                  </p>
                ))}
              </div>
            ))}
          </details>
        ))
      )}
    </div>
  );
}
