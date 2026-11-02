// F-005 (a) repair: captures the TRUE rendered iframe geometry for a specific
// matched application instance, instead of the whole browser window's
// innerWidth/innerHeight (which the pre-repair script reported as "viewport"
// but is not the packaged app's actual iframe size).
//
// src/features/runtime-ui/PackagedRuntimeUiRenderer.tsx renders exactly one
// `<iframe data-testid="runtime-ui-packaged-frame">` per mounted surface, with
// no per-instance id attribute (only a `title` derived from the resource name
// or applicationId) — see src/features/runtime-ui/RuntimeUiHost.tsx's
// `data-runtime-ui-surface` on the surface's wrapping container. Only one
// instance is ever mounted per surface at a time, so
// `[data-runtime-ui-surface="<surface>"] iframe[data-testid="runtime-ui-packaged-frame"]`
// uniquely identifies the matched instance's iframe. This module builds that
// expression as a static string template (never interpolating untrusted
// content) for evaluateInRenderer to run.

/** @param {{surface: string, expectedTitle?: string}} target */
export function buildFrameGeometryExpression(target) {
  const surface = JSON.stringify(target.surface);
  const expectedTitle = JSON.stringify(target.expectedTitle ?? null);
  return `(() => {
    const scope = document.querySelector(\`[data-runtime-ui-surface="\${${surface}}"]\`);
    const iframe = scope?.querySelector('iframe[data-testid="runtime-ui-packaged-frame"]');
    if (!iframe) return JSON.stringify(null);
    const expectedTitle = ${expectedTitle};
    const titleMatches = expectedTitle === null || iframe.title === expectedTitle;
    const rect = iframe.getBoundingClientRect();
    return JSON.stringify({
      titleMatches,
      actualTitle: iframe.title,
      width: rect.width,
      height: rect.height,
    });
  })()`;
}
