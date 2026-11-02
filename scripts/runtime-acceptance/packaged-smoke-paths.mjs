import path from "node:path";

export function resolvePackagedLifecycleRoot({ e2e, profileRoot, tempRoot, workerIndex }) {
  const workerSuffix = workerIndex ? `-${workerIndex}` : "";
  return e2e ? path.join(tempRoot, `marshal-e2e-data${workerSuffix}`) : profileRoot;
}
