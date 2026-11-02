// N-FF1b composition test: the REAL registered runtime-ui:getPlacements handler's response is fed,
// unmodified, through the REAL acceptance facility extractor + verifier
// (host-smoke/acceptance-facility/lib/identity-verification.mjs) — no shape mocks on either side.
// N-FF1b was exactly a composition gap: the producer projection (toDesktopPlacementApplication)
// emits TOP-LEVEL actions[]/tools[]/revisionId on each placement application entry, while the
// facility's verifyDeclaredActions expected a NESTED `application` manifest — each side's own suite
// was green, but composed the declared-actions gate could never report MET against the real bridge
// payload. This test lives next to runtime-ui-ipc.test.ts because it reuses the same harness
// pattern (registerRuntimeUiHandlers against a realistic publication service) and its subject is
// the bridge payload that handler actually produces; the facility side is imported as plain ESM.
import { createRuntimeServiceContainer } from "@marshal/runtime";
import {
  RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
  type RuntimeExtensionUiPublicationService,
  type RuntimeExtensionUiPublishedApplication,
  type RuntimeExtensionUiPublishedPlacement,
} from "@marshal/runtime/extensions";
import { describe, expect, it, vi } from "vitest";

import type { IpcHandler, IpcInvokeMap } from "../../common/marshal-ipc-contract";
import {
  findPublishedApplicationRecord,
  verifyDeclaredActions,
} from "../../host-smoke/acceptance-facility/lib/identity-verification.mjs";
import { MarshalRuntimeUiController, type RuntimeUiDeliveryPorts } from "../marshal-runtime";
import { testDouble } from "../testing/harness";
import { registerRuntimeUiHandlers } from "./runtime-ui-ipc";

type RegisteredHandler = (...args: unknown[]) => unknown;

const scope = { sessionId: "session-1", workspaceName: "workspace-1" };

// The real @marshal/code-review action ids, as captured from a live install.
const REAL_ACTION_IDS = [
  "codereview-pr-list",
  "codereview-pr-get",
  "codereview-pr-setAutoMerge",
  "codereview-thread-setDisposition",
  "codereview-thread-applySuggestion",
  "codereview-babysit-arm",
  "codereview-babysit-disarm",
  "codereview-pr-requestIteration",
  "codereview-thread-create",
  "codereview-thread-reply",
  "codereview-thread-discardOperation",
  "codereview-accounts-list",
  "codereview-accounts-connect",
  "codereview-sync-discover",
  "codereview-accounts-sources",
  "codereview-accounts-connectFromSource",
  "codereview-accounts-deviceFlow",
  "codereview-ai-ask",
  "codereview-ai-followup",
  "codereview-ai-assignReviewer",
  "codereview-ai-reviewArea",
] as const;

function manifestAction(id: string) {
  return {
    id,
    version: "1.0.0",
    title: id,
    target: { kind: "capability" as const, capability: id.replaceAll("-", ".") },
    inputSchema: {},
    outputSchema: {},
    allowedScopes: ["session" as const],
    requiredPermissions: [],
    risk: "write" as const,
    idempotency: "required" as const,
  };
}

function codeReviewApplication(
  actionIds: readonly string[],
): RuntimeExtensionUiPublishedApplication {
  return {
    id: "codereview.prs",
    ownerId: "@marshal/code-review",
    revisionId: "revision-codereview-7",
    title: "Pull Requests",
    description: "Review pull requests",
    renderId: "codereview.prs",
    resource: {
      uri: "ui://code-review/codereview.prs.html",
      mimeType: "text/html",
      text: "<main>PRs</main>",
    },
    application: {
      version: "1.0.0",
      presentationModes: ["inline", "fullscreen"],
      actions: actionIds.map(manifestAction),
      tools: [{ id: "codereview-babysit-tick", name: "codereview.babysit.tick", inputSchema: {} }],
    },
  };
}

async function captureRealGetPlacementsPayload(
  application: RuntimeExtensionUiPublishedApplication,
): Promise<unknown> {
  const delivery: RuntimeUiDeliveryPorts = {
    notification: vi.fn<RuntimeUiDeliveryPorts["notification"]>(),
    chatMessage: vi.fn<RuntimeUiDeliveryPorts["chatMessage"]>(),
    chatCard: vi.fn<RuntimeUiDeliveryPorts["chatCard"]>(),
  };
  const controller = new MarshalRuntimeUiController(
    () => Date.parse("2026-09-10T08:00:00.000Z"),
    (request) => ({ allowed: true, scope: request.scope }),
    delivery,
  );
  const placement: RuntimeExtensionUiPublishedPlacement = {
    ownerId: application.ownerId,
    revisionId: application.revisionId,
    placementId: "marshal.chat.composer.add",
    action: "augment",
    applicationId: application.id,
  };
  const publication = testDouble<RuntimeExtensionUiPublicationService>({
    listApplications: vi
      .fn<RuntimeExtensionUiPublicationService["listApplications"]>()
      .mockResolvedValue([application]),
    resolvePlacementState: vi
      .fn<RuntimeExtensionUiPublicationService["resolvePlacementState"]>()
      .mockResolvedValue({ placements: [placement] }),
  });
  const serviceContainer = createRuntimeServiceContainer();
  await serviceContainer.bind(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE, {
    useValue: publication,
  });
  const handlers = new Map<string, RegisteredHandler>();
  const dispose = registerRuntimeUiHandlers({
    controller,
    serviceContainer,
    ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => {
      handlers.set(channel, testDouble<RegisteredHandler>(handler));
    },
  });
  try {
    return await handlers.get("runtime-ui:getPlacements")!(undefined, scope);
  } finally {
    dispose();
  }
}

const TARGET = {
  identity: "@marshal/code-review",
  applicationId: "codereview.prs",
  expectedDeclaredActions: [...REAL_ACTION_IDS],
  expectedDeclaredTools: ["codereview.babysit.tick"],
};

/** A stale open instance whose content is access-trapped: reading its descriptor flips the flag. */
function trappedInstance() {
  let descriptorAccessed = false;
  const instance = {
    instanceId: "rui_stale",
    owner: { extensionId: TARGET.identity, applicationId: TARGET.applicationId },
    content: new Proxy(
      {
        kind: "application",
        renderId: "codereview.prs",
        descriptor: { version: "1.0.0", presentationModes: ["inline"], actions: [], tools: [] },
      },
      {
        get(object, property, receiver) {
          if (property === "descriptor") descriptorAccessed = true;
          return Reflect.get(object, property, receiver);
        },
      },
    ),
  };
  return { instance, wasDescriptorAccessed: () => descriptorAccessed };
}

describe("runtime-ui getPlacements × acceptance-facility declared-actions gate (N-FF1b composition)", () => {
  it("real handler payload through the real facility verifier reports MET with every declared id", async () => {
    const payload = await captureRealGetPlacementsPayload(codeReviewApplication(REAL_ACTION_IDS));

    const record = findPublishedApplicationRecord({ snapshot: payload, target: TARGET });
    expect(record).not.toBeNull();
    // Owner/scope identity anchoring: the extracted record is keyed by the same
    // extensionId/applicationId pair the instance owner anchors.
    expect(record).toMatchObject({
      extensionId: "@marshal/code-review",
      applicationId: "codereview.prs",
    });

    const { instance, wasDescriptorAccessed } = trappedInstance();
    const result = verifyDeclaredActions({
      target: TARGET,
      matchedInstance: instance,
      publication: { success: true, record },
    });

    expect(result.applicable).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.met).toBe(true);
    expect([...(result.declaredActions ?? [])].sort()).toEqual([...REAL_ACTION_IDS].sort());
    expect(result.declaredTools).toEqual(["codereview.babysit.tick"]);
    expect(result.revisionId).toBe("revision-codereview-7");
    // L2R-001 invariant carried through composition: the instance's open-time descriptor snapshot
    // is never consulted for the actions evidence.
    expect(wasDescriptorAccessed()).toBe(false);
  });

  it("a publication genuinely missing one expected action stays honestly unmet, naming it", async () => {
    const withoutApplySuggestion = REAL_ACTION_IDS.filter(
      (id) => id !== "codereview-thread-applySuggestion",
    );
    const payload = await captureRealGetPlacementsPayload(
      codeReviewApplication(withoutApplySuggestion),
    );

    const record = findPublishedApplicationRecord({ snapshot: payload, target: TARGET });
    expect(record).not.toBeNull();

    const { instance } = trappedInstance();
    const result = verifyDeclaredActions({
      target: TARGET,
      matchedInstance: instance,
      publication: { success: true, record },
    });

    expect(result.applicable).toBe(true);
    expect(result.met).toBe(false);
    expect(result.reason).toContain("codereview-thread-applySuggestion");
    expect(result.reason).toContain("do not match the expected");
  });
});
