import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useState } from "react";

import { Input } from "@/components/marshal-ui/input";
import { Label } from "@/components/marshal-ui/label";
import { Button } from "@/components/marshal-ui/marshal-button";
import { cn } from "@/lib/marshal-class-names";

import { SettingsRow } from "./SettingsRow";
import { SettingsBlock, SettingsSection } from "./SettingsSection";
export function RemoteAccessSection() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["remote-access"],
    queryFn: () => window.remoteAccessAPI!.getState(),
    enabled: !!window.remoteAccessAPI,
  });
  const [origin, setOrigin] = useState<string | undefined>();
  const [showKey, setShowKey] = useState(false);
  const mutation = useMutation({
    mutationFn: (input: { enabled: boolean; rotateKey?: boolean }) =>
      window.remoteAccessAPI!.configure({ ...input, origin: origin ?? query.data?.origin ?? "" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["remote-access"] }),
  });
  const setup = useMutation({
    mutationFn: () => window.remoteAccessAPI!.setupTailscale(),
    onSuccess: (state) => {
      setOrigin(state.origin);
      void client.invalidateQueries({ queryKey: ["remote-access"] });
    },
  });
  const qr = useQuery({
    queryKey: ["remote-access-qr", query.data?.origin, query.data?.accessKey],
    enabled: showKey && !!query.data?.origin && query.data?.running,
    queryFn: () =>
      QRCode.toDataURL(`${query.data!.origin}/#key=${encodeURIComponent(query.data!.accessKey)}`, {
        width: 240,
        margin: 2,
      }),
  });
  if (!window.remoteAccessAPI || !query.data) return null;
  const state = query.data;
  const status = state.running ? "Ready" : state.enabled ? "Unable to start" : "Disabled";
  return (
    <SettingsSection
      title="iPhone access"
      description="Use the same chats privately through Tailscale. Marshal stays running and keeps your Mac awake while enabled."
      action={
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
            state.running
              ? "border-status-success-border bg-status-success-bg text-status-success-fg"
              : "border-border/70 text-muted-foreground",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full",
              state.running ? "bg-success" : "bg-muted-foreground/60",
            )}
          />
          {status}
        </span>
      }
    >
      <SettingsRow
        label="Tailscale"
        description="Detect this Mac's Tailscale HTTPS address automatically."
      >
        <Button
          size="sm"
          variant="outline"
          disabled={setup.isPending}
          onClick={() => setup.mutate()}
        >
          {setup.isPending ? "Connecting…" : "Connect with Tailscale"}
        </Button>
      </SettingsRow>
      <SettingsBlock>
        <Label htmlFor="remote-access-origin" className="text-[13px] font-medium">
          Tailscale HTTPS address
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="remote-access-origin"
            className="min-w-0 flex-1"
            value={origin ?? state.origin}
            placeholder="https://your-mac.your-tailnet.ts.net"
            onChange={(e) => setOrigin(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate({ enabled: state.enabled })}
          >
            Save address
          </Button>
        </div>
        {setup.error && (
          <p role="alert" className="text-sm text-destructive">
            {setup.error.message}
          </p>
        )}
      </SettingsBlock>
      <SettingsRow
        label="Remote access"
        description={
          state.running ? (
            <a
              className="underline underline-offset-2"
              href={state.origin || `http://127.0.0.1:${state.port}`}
              target="_blank"
              rel="noreferrer"
            >
              Open phone view
            </a>
          ) : (
            "Allow paired devices to reach this Mac."
          )
        }
      >
        <Button
          size="sm"
          variant={state.enabled ? "outline" : "brand"}
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({ enabled: !state.enabled })}
        >
          {state.enabled ? "Disable access" : "Enable access"}
        </Button>
      </SettingsRow>
      <SettingsRow
        label="Access key"
        description="Pair a device by scanning the code or pasting the key."
      >
        <Button size="sm" variant="ghost" onClick={() => setShowKey(!showKey)}>
          {showKey ? "Hide access key" : "Show access key"}
        </Button>
      </SettingsRow>
      {showKey && (
        <SettingsBlock>
          {qr.data && (
            <div className="flex flex-col items-start gap-2">
              <img
                src={qr.data}
                width={200}
                height={200}
                className="rounded-xl border border-border/70 bg-white p-1"
                alt="Scan with your iPhone camera to connect to Marshal"
              />
              <p className="text-xs text-muted-foreground">
                Scan with your iPhone camera while Tailscale is connected.
              </p>
            </div>
          )}
          <code className="block rounded-lg bg-muted px-3 py-2 font-mono text-xs break-all select-all">
            {state.accessKey}
          </code>
          <Button
            size="sm"
            variant="destructive"
            className="self-start"
            onClick={() => mutation.mutate({ enabled: state.enabled, rotateKey: true })}
          >
            Reset key and disconnect all devices
          </Button>
        </SettingsBlock>
      )}
      {(state.error || mutation.error) && (
        <SettingsBlock>
          <p role="alert" className="text-sm text-destructive">
            {state.error || mutation.error?.message}
          </p>
        </SettingsBlock>
      )}
    </SettingsSection>
  );
}
