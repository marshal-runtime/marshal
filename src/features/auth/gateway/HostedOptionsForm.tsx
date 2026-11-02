import type { GatewayAuthIdentity } from "@common/marshal-ipc-contract";
import { useState } from "react";

import { Loader2 } from "@/components/icons";
import { Input } from "@/components/marshal-ui/input";
import { Label } from "@/components/marshal-ui/label";
import { Button } from "@/components/marshal-ui/marshal-button";
import { InteractiveElementMonitor_SignIn } from "@/services/telemetry/schema";

// Survive sign-out so the form re-opens on the user's last node name.
const STORAGE_KEY_NODE_NAME = "gateway-hosted-form:lastNodeName";
// Legacy key — written by the pre-cleanup role-mode radio group. Clean up
// on read so returning users don't carry it forever.
const LEGACY_STORAGE_KEY_ROLE_MODE = "gateway-hosted-form:lastRoleMode";

function readLastNodeName(): string | null {
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY_ROLE_MODE);
    const raw = window.localStorage.getItem(STORAGE_KEY_NODE_NAME);
    return raw && raw.trim().length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function rememberNodeName(nodeName: string | undefined): void {
  try {
    if (nodeName && nodeName.trim().length > 0) {
      window.localStorage.setItem(STORAGE_KEY_NODE_NAME, nodeName);
    }
  } catch {
    // empty
  }
}

interface HostedOptionsFormProps {
  onSubmit: (cred: GatewayAuthIdentity) => void;
  defaultNodeName?: string;
  disabled?: boolean;
}

export function HostedOptionsForm({
  onSubmit,
  defaultNodeName = "",
  disabled = false,
}: HostedOptionsFormProps) {
  const [nodeName, setNodeName] = useState(() => readLastNodeName() ?? defaultNodeName);

  const trimmedNodeName = nodeName.trim();
  // Omit when unchanged from default so main can resolve to the OS hostname itself.
  const effectiveNodeName =
    trimmedNodeName.length > 0 && trimmedNodeName !== defaultNodeName.trim()
      ? trimmedNodeName
      : undefined;

  return (
    <div className="flex w-full flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="node-name-input">Node display name (optional)</Label>
        <Input
          id="node-name-input"
          value={nodeName}
          onChange={(e) => setNodeName(e.target.value)}
          disabled={disabled}
          placeholder={defaultNodeName || "e.g. Harry's MacBook"}
          data-testid="hosted-options-node-name"
        />
        <p className="text-xs text-muted-foreground">
          Surfaces in the gateway's pair-request so other paired devices can recognise this one.
        </p>
      </div>

      <InteractiveElementMonitor_SignIn
        callback={() => {
          rememberNodeName(trimmedNodeName.length > 0 ? trimmedNodeName : undefined);
          onSubmit({
            mode: "hosted",
            roleMode: "operator-and-node",
            ...(effectiveNodeName ? { nodeName: effectiveNodeName } : {}),
          });
        }}
      >
        {(cb) => (
          <Button
            variant="brand"
            onClick={cb}
            disabled={disabled}
            data-testid="hosted-options-submit"
            className="h-auto w-full rounded-card py-2 text-base"
          >
            {disabled ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Connecting…
              </>
            ) : (
              "Continue"
            )}
          </Button>
        )}
      </InteractiveElementMonitor_SignIn>
    </div>
  );
}
