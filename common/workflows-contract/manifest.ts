// common/workflows-contract/manifest.ts
//
// `manifest.json` schema for an installed dynamic workflow. Lives next to
// `workflow.ts` / `dist/workflow.js` inside `~/.marshal/marshal-workflows/<id>/`
// or a repo's `.github/marshal-workflows/<id>/`. The `source` field
// is NEVER read from disk per r1-fixes A12 — `.installed.json` is the
// trusted sidecar.

import { z } from "zod";

export const WorkflowPermissionsSchema = z.object({
  /**
   * `allow-all` → every subagent the workflow spawns is created with
   * `permissionMode: "allow-all"`. The trust prompt at install time MUST
   * disclose this; bundled workflows ship with implicit consent.
   * `ask` → permission cards route through the workflow's tab (r1-fixes A10).
   */
  mode: z.enum(["allow-all", "ask"]),
});

export const WorkflowCatalogExtensionsSchema = z.object({
  visibility: z.enum(["visible", "hidden"]).optional(),
  reason: z.string().max(500).optional(),
});

export const WorkflowApiDocItemSchema = z.object({
  key: z.string().min(1).max(300),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  mime: z.string().max(100).optional(),
});

export const WorkflowNotificationDestinationSchema = z.enum(["email"]);

const WorkflowVisibleNotificationDestinationsSchema = z
  .array(z.string())
  .transform((values) =>
    values.filter(
      (value): value is z.infer<typeof WorkflowNotificationDestinationSchema> =>
        WorkflowNotificationDestinationSchema.safeParse(value).success,
    ),
  );

export const WorkflowNotificationDetailLevelSchema = z.enum([
  "generic",
  "title-only",
  "summary",
  "detailed",
]);

export const WorkflowActionDispatchStatusSchema = z.enum([
  "proposed",
  "pending",
  "running",
  "active",
  "completed",
  "failed",
  "cancelled",
]);

export const WorkflowManifestExtensionsSchema = z.object({
  catalog: WorkflowCatalogExtensionsSchema.optional(),
  domain: z
    .object({
      kind: z.literal("general").optional(),
      teamIdDescription: z.string().max(2000).optional(),
    })
    .optional(),
  notificationRouting: z
    .object({
      visibleDestinations: WorkflowVisibleNotificationDestinationsSchema.optional(),
      policyDefaults: z
        .object({
          approvalRequired: z.boolean().optional(),
          detailLevel: WorkflowNotificationDetailLevelSchema.optional(),
          dedupeWindowMs: z.number().int().nonnegative().optional(),
          minimumUrgency: z.enum(["low", "normal", "high", "critical"]).optional(),
          externalWriteMode: z.enum(["propose", "allow"]).optional(),
        })
        .optional(),
    })
    .optional(),
  actionCenter: z
    .object({
      dispatchStatuses: z.array(WorkflowActionDispatchStatusSchema).optional(),
      workflowScopedToolsOnly: z.boolean().optional(),
      forceNavigationOnDispatch: z.literal(false).optional(),
    })
    .optional(),
  apiDocs: z
    .object({
      stateKeys: z.array(WorkflowApiDocItemSchema).optional(),
      artifactKeys: z.array(WorkflowApiDocItemSchema).optional(),
      actions: z.array(WorkflowApiDocItemSchema).optional(),
    })
    .optional(),
});

export const WorkflowManifestSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(128)
    .regex(
      /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
      "id must be kebab-case (lowercase letters, digits, hyphens; cannot start or end with a hyphen)",
    ),
  version: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  permissions: WorkflowPermissionsSchema,
  /** Optional natural-language schedule string. The workflow scheduler
   * auto-registers manifest schedules on restore; users can edit or disable
   * them from the Workflows panel. */
  schedule: z.string().optional(),
  /**
   * Renderer hint: `"default"` (or omitted) uses the generic renderer.
   * Bundled and user-installed workflows may ship a `renderer.tsx`; the user
   * install path compiles it to `dist/renderer.js` and the renderer loads it
   * through the Workflows tab slot system.
   */
  renderer: z.union([z.literal("default"), z.object({ component: z.string() })]).optional(),
  /**
   * Cloud-sync gating (r1-fixes "inherit-host" decision). When `"off"`,
   * the host session AND all subagents skip cloud sync regardless of
   * the global setting. Defaults to `"inherit-host"` when omitted.
   */
  cloudSync: z.enum(["off", "on", "inherit-host"]).default("inherit-host"),
  /**
   * Optional notification on terminal status (r1-fixes C16). Default is
   * `"none"`. Manifests written before Teams was removed may still say
   * `"teams"`; they load as `"none"`.
   */
  notifyOnComplete: z
    .preprocess((value) => (value === "teams" ? "none" : value), z.enum(["system", "none"]))
    .default("none"),
  extensions: WorkflowManifestExtensionsSchema.optional(),
});

export type WorkflowManifest = z.infer<typeof WorkflowManifestSchema>;

export function isWorkflowCatalogVisible(manifest: WorkflowManifest): boolean {
  return manifest.extensions?.catalog?.visibility !== "hidden";
}

/** Sidecar — written by the install transport, NOT trusted from manifest.json. */
export const InstalledSourceSchema = z.object({
  /** Authoritative source field (see r1-fixes A12). */
  source: z.enum(["bundled", "user-local", "imported", "repo-local"]),
  /** When the install transport ran (epoch ms). */
  installedAt: z.number().int().nonnegative(),
  /** SHA-256 of the compiled `dist/workflow.js` at install time. */
  distHash: z.string(),
  /** SemVer of the workflow at install time, for change detection. */
  version: z.string(),
});

export type InstalledSource = z.infer<typeof InstalledSourceSchema>;
