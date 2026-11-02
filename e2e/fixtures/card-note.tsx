/**
 * E2E fixture: a tiny agent-authored card that shows its label, used to
 * prove where permanent, transient and slot-bound cards render.
 */
interface Props {
  label?: string;
}

export default function CardNote({ label = "unlabelled" }: Props) {
  return (
    <div style={{ padding: 12, fontFamily: "system-ui", fontSize: 14 }}>
      <strong data-testid="card-note-label">{label}</strong>
    </div>
  );
}
