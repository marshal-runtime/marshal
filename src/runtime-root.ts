import { getRuntimeMetadata, type RuntimeRendererRoot } from "@common/runtime-config";

export function resolveRuntimeRoot(runtimeId: string): RuntimeRendererRoot {
  return getRuntimeMetadata(runtimeId).rendererRoot;
}
