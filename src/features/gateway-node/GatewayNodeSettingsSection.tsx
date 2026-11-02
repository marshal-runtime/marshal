import { roleModeIncludesNode } from "@common/marshal-ipc-contract";
import { useQueryClient } from "@tanstack/react-query";

import { Switch } from "@/components/marshal-ui/marshal-switch";
import { useGatewayAuth } from "@/features/auth/gateway/useGatewayDeviceAuth";
import { SettingsRow } from "@/features/settings/SettingsRow";
import { SettingsBlock, SettingsSection } from "@/features/settings/SettingsSection";
import { useMcpServers } from "@/shared/hooks/useMcpServerCatalog";

import { GatewayNodeActivityList } from "./GatewayNodeActivityList";

export function GatewayNodeSettingsSection() {
  const { status, identity } = useGatewayAuth();
  const { data: servers = [] } = useMcpServers();
  const queryClient = useQueryClient();

  const customServers = servers.filter((s) => !s.builtin && s.config);

  const setExpose = async (name: string, expose: boolean) => {
    await window.mcpsAPI?.setExposeAsGatewayNodeCommand(name, expose);
    void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
  };

  if (status !== "signed-in" || !roleModeIncludesNode(identity?.roleMode)) return null;
  return (
    <SettingsSection
      title="Gateway node"
      description="Inbound commands from the gateway. Showing the most recent 100."
    >
      {customServers.length > 0 &&
        customServers.map((s) => (
          <SettingsRow
            key={s.name}
            label={s.name}
            description="Make this MCP server available as a command on paired devices."
          >
            <Switch
              aria-label={`Share ${s.name} with paired devices`}
              checked={s.config?.exposeAsGatewayNodeCommand === true}
              onCheckedChange={(v) => void setExpose(s.name, v)}
            />
          </SettingsRow>
        ))}
      <SettingsBlock>
        <GatewayNodeActivityList />
      </SettingsBlock>
    </SettingsSection>
  );
}
