/**
 * Renderer scaffold. Only used by BUNDLED workflows in V1 —
 * The UI/CLI importer will warn and ignore a renderer.tsx in a
 * user-supplied folder.
 *
 * Locked render props — see ../references/renderer-authoring.md.
 */
import { defineRenderer, type WorkflowRunRendererProps } from "@marshal/workflow-sdk";

function RunView(props: WorkflowRunRendererProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <div className="text-base font-semibold text-(--text-primary)">{props.run.workflowId}</div>
        <div className="text-xs text-(--text-secondary)">{props.run.status}</div>
      </header>

      <section>
        <h3 className="mb-1 text-sm font-medium text-(--text-primary)">Steps</h3>
        <ul className="space-y-1">
          {props.run.steps.map((s) => (
            <li key={s.stepKey} className="flex items-center gap-2 text-sm">
              <span className="text-(--text-secondary)">{s.status}</span>
              <span className="text-(--text-primary)">{s.id}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium text-(--text-primary)">
          Artifacts ({props.artifacts.length})
        </h3>
        <ul className="space-y-1 text-xs text-(--text-secondary)">
          {props.artifacts.map((a) => (
            <li key={a.key}>
              {a.key} · {a.sizeBytes} bytes · {a.mime}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export default defineRenderer({
  workflowId: "TODO-kebab-case-id",
  render: RunView,
});
