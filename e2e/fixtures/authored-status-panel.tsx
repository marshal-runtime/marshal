/**
 * E2E fixture: minimal agent-authored React component for placement testing.
 * Compiled via ui.compile, rendered via ui.render with a manifest declaring
 * ONE safe read action (capability ui.renders.list). The refresh button calls
 * it through the injected marshal client and renders the observed result.
 */
import { useCallback, useState } from "react";

interface Props {
  label?: string;
  marshal?: {
    callAction(
      actionId: string,
      input: unknown,
      options: { scope: string; idempotencyKey?: string },
    ): Promise<unknown>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function renderCount(value: unknown): string {
  const output = isRecord(value) && isRecord(value.output) ? value.output : value;
  const renders = isRecord(output) ? output.renders : undefined;
  return Array.isArray(renders) ? String(renders.length) : "?";
}

/**
 * Envelope self-check: the documented contract is that callAction resolves to
 * UiActionResult {status, output, ...} — exactly one layer, with the module's
 * return at .output. Any extra {value}/{result} wrapper or stringified body
 * shows up as "wrapped"/"string" in the rendered text.
 */
function describeEnvelope(value: unknown): string {
  if (typeof value === "string") return "string";
  if (!isRecord(value)) return "missing";
  if ("value" in value || "result" in value) return "wrapped";
  if (value.status === "success" && isRecord(value.output)) return "single";
  return "unexpected";
}

export default function AuthoredStatusPanel({ label = "unlabelled", marshal }: Props) {
  const [result, setResult] = useState("untouched");
  const [echo, setEcho] = useState("untouched");
  const [entropy, setEntropy] = useState("untouched");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!marshal || busy) return;
    setBusy(true);
    try {
      const value = await marshal.callAction(
        "list-renders",
        {},
        {
          scope: "session",
          idempotencyKey: `e2e-refresh-${Date.now()}`,
        },
      );
      setResult(`renders:${renderCount(value)}`);
    } catch (error) {
      setResult(`error:${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [marshal, busy]);
  const echoInput = useCallback(async () => {
    if (!marshal || busy) return;
    setBusy(true);
    try {
      const value = await marshal.callAction(
        "echo-input",
        { agentId: "e2e-agent", seed: 7 },
        { scope: "session", idempotencyKey: `e2e-echo-${Date.now()}-${Math.random()}` },
      );
      const output = isRecord(value) && isRecord(value.output) ? value.output : null;
      const raw = JSON.stringify(value);
      setEcho(
        `echo|${describeEnvelope(value)}|${output ? String(output.receivedType) : "?"}|${
          output ? String(output.agentId) : "?"
        }|raw:${raw ? raw.slice(0, 400) : "?"}`,
      );
    } catch (error) {
      setEcho(`echo|error|${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [marshal, busy]);
  const sampleEntropy = useCallback(() => {
    setEntropy(`entropy|${Date.now()}|${Math.random()}`);
  }, []);
  return (
    <main style={{ fontFamily: "sans-serif", padding: 12 }}>
      <h1 data-testid="label">{label}</h1>
      <button type="button" data-testid="refresh" onClick={refresh} disabled={busy || !marshal}>
        Refresh
      </button>
      <button type="button" data-testid="echo" onClick={echoInput} disabled={busy || !marshal}>
        Echo input
      </button>
      <button type="button" data-testid="entropy" onClick={sampleEntropy}>
        Sample entropy
      </button>
      <output data-testid="result">{result}</output>
      <output data-testid="echo-result">{echo}</output>
      <output data-testid="entropy-result">{entropy}</output>
    </main>
  );
}
