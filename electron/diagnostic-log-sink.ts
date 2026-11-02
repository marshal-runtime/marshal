import { addLogSink } from "../common/marshal-logger";
import { writeDiagnosticEntry } from "./diagnostic-logger";
import { serializeLogArg } from "./foundation/logging/arg-serializer";

export function addDiagnosticLogSink(): () => void {
  return addLogSink((entry) => {
    writeDiagnosticEntry({
      level: entry.level,
      category: entry.tag,
      message: entry.args.map(serializeLogArg).join(" "),
      metadata: Object.keys(entry.context).length ? entry.context : undefined,
    });
  });
}
