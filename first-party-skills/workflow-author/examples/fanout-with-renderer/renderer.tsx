/**
 * Custom renderer for the fanout-with-renderer example.
 *
 * Demonstrates: subscribing to run steps, rendering a unit grid with theme
 * tokens, calling action props. No `fs`, no `electron`, no host tools.
 */
import { defineRenderer, type WorkflowRunRendererProps } from "@marshal/workflow-sdk";

const STATUS_TONE: Record<string, string> = {
  pending: "text-(--text-secondary)",
  running: "text-(--accent)",
  succeeded: "text-(--success)",
  failed: "text-(--danger)",
  skipped: "text-(--text-secondary)",
};

function GridView(props: WorkflowRunRendererProps) {
  const units = props.run.steps.filter((s) => s.stepKey.includes("/investigate"));
  return (
    <div className="flex flex-col gap-3 p-3">
      <header className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-(--text-primary)">{props.run.workflowId}</h2>
        <span className="text-xs text-(--text-secondary)">{props.run.status}</span>
      </header>

      {units.length === 0 ? (
        <p className="text-sm text-(--text-secondary)">Run hasn't produced units yet.</p>
      ) : (
        <ul className="grid grid-cols-3 gap-2">
          {units.map((u) => (
            <li
              key={u.stepKey}
              className="flex flex-col gap-1 rounded border border-(--border) bg-(--surface-1) p-2"
            >
              <span className="text-xs font-medium text-(--text-primary)">{u.id}</span>
              <span className={`text-xs ${STATUS_TONE[u.status] ?? ""}`}>{u.status}</span>
              {u.error ? <span className="text-xs text-(--danger)">{u.error.message}</span> : null}
            </li>
          ))}
        </ul>
      )}

      {props.artifacts.length > 0 ? (
        <footer className="text-xs text-(--text-secondary)">
          {props.artifacts.length} artifact(s)
        </footer>
      ) : null}
    </div>
  );
}

export default defineRenderer({
  workflowId: "fanout-with-renderer",
  render: GridView,
});
