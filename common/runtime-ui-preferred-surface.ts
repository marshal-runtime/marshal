import { RUNTIME_UI_SURFACES, type RuntimeUiSurface } from "./runtime-ui";

/**
 * Publication metadata key naming the surface a session-scoped placement activation
 * (for example a chat composer action) opens the application on. Absent or unknown
 * values keep the default derived from the manifest's presentation modes.
 */
export const MARSHAL_UI_PREFERRED_SURFACE_METADATA_KEY = "marshal.ui.preferredSurface";

export function preferredUiSurfaceFromMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): RuntimeUiSurface | undefined {
  const value = metadata?.[MARSHAL_UI_PREFERRED_SURFACE_METADATA_KEY];
  return RUNTIME_UI_SURFACES.find((surface) => surface === value);
}
