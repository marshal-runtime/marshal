import { roleModeIncludesOperator } from "@common/marshal-ipc-contract";
import { useEffect, type ReactNode } from "react";

import { GatewayNodeWorkspace } from "@/features/gateway-node/shell/GatewayNodeWorkspace";
import { wireGatewayNodeActivity } from "@/features/gateway-node/wireGatewayNodeActivity";
import { queryClient } from "@/services/query/query-client";

import { GatewayReconnectingBanner } from "./GatewayReconnectingBanner";
import { useGatewayAuth } from "./useGatewayDeviceAuth";

interface GatewayAppShellProps {
  children: ReactNode;
}

export function GatewayAppShell({ children }: GatewayAppShellProps) {
  const { signOut, identity } = useGatewayAuth();
  const isOperator = roleModeIncludesOperator(identity?.roleMode);

  useEffect(() => wireGatewayNodeActivity(queryClient), []);

  return (
    <div className="flex size-full flex-col">
      <GatewayReconnectingBanner />
      <div className={isOperator ? "min-h-0 flex-1" : "flex-1"} data-testid="gateway-app-content">
        {isOperator ? (
          children
        ) : (
          <GatewayNodeWorkspace identity={identity} onSignOut={() => void signOut()} />
        )}
      </div>
    </div>
  );
}
