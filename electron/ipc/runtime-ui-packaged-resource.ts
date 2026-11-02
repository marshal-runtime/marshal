import { createHash, randomUUID } from "node:crypto";

import type { RuntimeExtensionUiPublishedApplication } from "@marshal/runtime/extensions";

import type {
  RuntimeUiApplicationContent,
  RuntimeUiApplicationResourceContent,
  RuntimeUiInstance,
} from "../../common/runtime-ui";
import {
  AUTHORED_UI_VIEWPORTS_PROP,
  declaredUiViewportsFromMetadata,
  type MarshalUiViewport,
  parseUiViewports,
} from "../../common/runtime-ui-viewports";
import type { MarshalRuntimeApi, MarshalRuntimeScope } from "../marshal-runtime/contracts";

export const MAX_PACKAGED_UI_BYTES = 8 * 1024 * 1024;

export function findPublishedUiApplication(
  instance: RuntimeUiInstance & { readonly content: RuntimeUiApplicationContent },
  applications: readonly RuntimeExtensionUiPublishedApplication[],
): RuntimeExtensionUiPublishedApplication | undefined {
  return applications.find(
    (application) =>
      application.ownerId === instance.owner.extensionId &&
      application.id === instance.owner.applicationId &&
      application.renderId === instance.content.renderId &&
      application.resource.uri === instance.content.resource.uri,
  );
}

/**
 * Authored renders publish no inline resource text: the template resolves
 * through the runtime resource port, which returns unversioned content. The
 * packaged renderer refuses unversioned HTML, so seal the port result with the
 * revision pin from the trusted instance (authored projections publish
 * revisionId === renderId, both content-addressed) and a computed integrity —
 * same size/shape validation as published inline resources.
 */
export function sealAuthoredUiResource(
  resource: RuntimeUiApplicationResourceContent,
  revisionId: string,
  viewports?: readonly MarshalUiViewport[],
): RuntimeUiApplicationResourceContent {
  if (
    typeof resource.text !== "string" ||
    Buffer.byteLength(resource.text) > MAX_PACKAGED_UI_BYTES
  ) {
    throw new Error("Packaged UI resources must contain at most 8 MiB of text.");
  }
  return {
    uri: resource.uri,
    mimeType: resource.mimeType ?? "text/plain",
    text: resource.text,
    revisionId,
    integrity: `sha256-${createHash("sha256").update(resource.text).digest("base64")}`,
    ...(viewports?.length ? { viewports: [...viewports] } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Authored renders declare their viewports in a reserved render prop
 * (common/runtime-ui-viewports.ts). Read it so the renderer's resource-level
 * gate lets a phone view through. Any failure keeps the desktop-only default.
 */
export async function readAuthoredRenderViewports(
  api: MarshalRuntimeApi | undefined,
  scope: MarshalRuntimeScope,
  renderId: string,
): Promise<readonly MarshalUiViewport[] | undefined> {
  if (!api) return undefined;
  try {
    const result = await api.invoke({
      ...scope,
      capability: "ui.renders.get",
      input: { renderId },
      idempotencyKey: `runtime-ui:render-viewports:${randomUUID()}`,
      origin: "runtime-ui",
      approvalPolicy: "forbid",
    });
    if (!result.ok || !isRecord(result.value.output)) return undefined;
    const render = result.value.output.render;
    const props = isRecord(render) && isRecord(render.props) ? render.props : undefined;
    const declared = parseUiViewports(props?.[AUTHORED_UI_VIEWPORTS_PROP]);
    return declared ? [...declared] : undefined;
  } catch {
    return undefined;
  }
}

export function readPublishedUiResource(
  application: RuntimeExtensionUiPublishedApplication,
  uri: string,
): RuntimeUiApplicationResourceContent {
  if (application.resource.uri !== uri) {
    throw new Error("The application has not published this resource.");
  }
  const { resource } = application;
  const mimeType = resource.mimeType ?? "text/plain";
  if (
    typeof resource.text !== "string" ||
    Buffer.byteLength(resource.text) > MAX_PACKAGED_UI_BYTES
  ) {
    throw new Error("Packaged UI resources must contain at most 8 MiB of text.");
  }
  const declaredViewports = declaredUiViewportsFromMetadata(application.metadata);
  return {
    uri: resource.uri,
    mimeType,
    text: resource.text,
    revisionId: application.revisionId,
    integrity: `sha256-${createHash("sha256").update(resource.text).digest("base64")}`,
    ...(declaredViewports ? { viewports: [...declaredViewports] } : {}),
  };
}
