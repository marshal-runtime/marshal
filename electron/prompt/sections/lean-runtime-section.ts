import { DEEP_RUNTIME_EDITS } from "./lean-deep-sections";
import { applySectionEdits, sectionBody, sliceBetween } from "./lean-projection";

export const RUNTIME_UI_AUTHORING_SKILL = "runtime-ui-authoring";

const CUSTOM_UI_HEADING = "Custom UI capabilities";

function leanCustomUiSection(legacyCustomUi: string): string {
  const whereViewsGo = sliceBetween(
    legacyCustomUi,
    "### Where views go",
    "Lifecycle recipe for a registered application:",
  );
  return `## ${CUSTOM_UI_HEADING}

All UI is invoked through \`runtimeInvoke\` and each capability is permission-gated. \`ui.document.open {path, idempotencyKey}\` opens a local file (absolute path) in Marshal's editor in the evidence panel — the right way to show a document or report; do not compile TSX or generate HTML just to display a file. The other UI capabilities (\`ui.application.open/update/focus/close\`, \`ui.chat.card.show\`, \`ui.notification.show\`, \`ui.layout.get\`, \`ui.view.move\`, …) are found with \`runtimeSearch\`; read an exact-name schema before first use. Never fake UI with screenshots or prose when a real surface was requested — if a placement call fails, report exactly what failed.

**Interactive UI** — buttons or forms that call capabilities, persisted state, or an application manifest — needs the authoring loop (\`ui.compile\` → \`ui.render\` → \`ui.application.open\`). Load skill \`${RUNTIME_UI_AUTHORING_SKILL}\` (\`getSkill {name: "${RUNTIME_UI_AUTHORING_SKILL}"}\`) before writing it. Display-only UI needs no skill: use \`runtimeShowUi\` below, including custom \`tsx\`.

${whereViewsGo}`;
}

/** Sections that move to the on-demand \`runtime-ui-authoring\` skill. */
export const RUNTIME_UI_AUTHORING_SKILL_SECTIONS: readonly string[] = [
  CUSTOM_UI_HEADING,
  "Building custom React UI (agent-authored, end to end)",
  'Two different "surface" vocabularies — never conflate them',
  "Composing capabilities with brokered TypeScript",
];

export function buildLeanRuntimeTemplate(legacyTemplate: string): string {
  return applySectionEdits(legacyTemplate, [
    {
      heading: CUSTOM_UI_HEADING,
      replacement: leanCustomUiSection(sectionBody(legacyTemplate, CUSTOM_UI_HEADING)),
    },
    { heading: "Building custom React UI (agent-authored, end to end)" },
    { heading: 'Two different "surface" vocabularies — never conflate them' },
    { heading: "Composing capabilities with brokered TypeScript" },
  ]);
}

/** Stage B trims; runs after the TypeScript subsection is substituted so its headings exist. */
export function applyDeepRuntimeTrims(text: string): string {
  return applySectionEdits(text, DEEP_RUNTIME_EDITS, { tolerateMissing: true });
}
