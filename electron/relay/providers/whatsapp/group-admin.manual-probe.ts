import {
  WhatsAppGroupAdministration,
  createWhatsAppCommunityRef,
  createWhatsAppGroupRef,
  type WhatsAppGroupScope,
} from "./group-admin";

export const WHATSAPP_GROUP_MANUAL_PROBE_CONFIRMATION = "RUN_WHATSAPP_GROUP_ADMIN_LIVE_PROBE";

export interface WhatsAppGroupManualProbeParameters {
  readonly confirmation: string;
  readonly scope: WhatsAppGroupScope;
  readonly communityId: string;
  readonly groupId: string;
  readonly expectedTitle: string;
  readonly temporaryTitle: string;
}

export interface WhatsAppGroupManualProbeResult {
  readonly validatedParent: true;
  readonly originalTitle: string;
  readonly restoredTitle: string;
}

export async function runWhatsAppGroupManualProbe(
  administration: WhatsAppGroupAdministration,
  parameters: WhatsAppGroupManualProbeParameters,
): Promise<WhatsAppGroupManualProbeResult> {
  if (parameters.confirmation !== WHATSAPP_GROUP_MANUAL_PROBE_CONFIRMATION) {
    throw new Error(
      `Manual WhatsApp group probe requires confirmation "${WHATSAPP_GROUP_MANUAL_PROBE_CONFIRMATION}"`,
    );
  }
  if (
    parameters.scope.providerId !== administration.scope.providerId ||
    parameters.scope.accountId !== administration.scope.accountId
  ) {
    throw new Error("Manual WhatsApp group probe scope does not match the administration port");
  }
  const expectedTitle = requireProbeTitle("expectedTitle", parameters.expectedTitle);
  const temporaryTitle = requireProbeTitle("temporaryTitle", parameters.temporaryTitle);
  if (expectedTitle === temporaryTitle) {
    throw new Error("Manual WhatsApp group probe temporaryTitle must differ from expectedTitle");
  }

  const communityRef = createWhatsAppCommunityRef(parameters.scope, parameters.communityId);
  const groupRef = createWhatsAppGroupRef(parameters.scope, parameters.groupId);
  await administration.validateLinkedParent(communityRef, groupRef);
  const group = await administration.getConversation(groupRef);
  if (!group) throw new Error("Manual WhatsApp group probe target group is unavailable");
  if (group.title !== expectedTitle) {
    throw new Error("Manual WhatsApp group probe target title does not match expectedTitle");
  }

  try {
    await administration.renameConversation(groupRef, temporaryTitle);
    await restoreOriginalTitle(administration, groupRef, expectedTitle);
  } catch (probeError) {
    try {
      await restoreOriginalTitle(administration, groupRef, expectedTitle);
    } catch (restorationError) {
      throw new Error("Manual WhatsApp group probe could not restore the original title", {
        cause: restorationError,
      });
    }
    throw new Error("Manual WhatsApp group probe failed after restoring the original title", {
      cause: probeError,
    });
  }

  return {
    validatedParent: true,
    originalTitle: expectedTitle,
    restoredTitle: expectedTitle,
  };
}

async function restoreOriginalTitle(
  administration: WhatsAppGroupAdministration,
  groupRef: ReturnType<typeof createWhatsAppGroupRef>,
  expectedTitle: string,
): Promise<void> {
  await administration.forceRenameConversation(groupRef, expectedTitle);
  const restored = await administration.getConversation(groupRef);
  if (!restored || restored.title !== expectedTitle) {
    throw new Error("Manual WhatsApp group probe could not verify the restored title");
  }
}

function requireProbeTitle(label: string, value: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`Manual WhatsApp group probe ${label} must be explicit and trimmed`);
  }
  return value;
}
