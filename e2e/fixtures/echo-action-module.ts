/**
 * E2E fixture: module-target action body. Echoes how the input actually
 * arrived at the module boundary so the placement E2E can prove object
 * fidelity end to end (component click -> bridge -> IPC -> render-tool plane
 * -> action dispatcher -> module executor).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export default async (raw: unknown) => {
  const record = isRecord(raw) ? raw : null;
  return {
    receivedType: typeof raw,
    isArray: Array.isArray(raw),
    agentId: record && typeof record.agentId === "string" ? record.agentId : null,
    seed: record && typeof record.seed === "number" ? record.seed : null,
  };
};
