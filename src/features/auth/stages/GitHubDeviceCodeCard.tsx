import { useState } from "react";

import { Copy, Check } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { useTimeout } from "@/runtime-ui/hooks/use-timeout";
import {
  InteractiveElementMonitor_Copy,
  InteractiveElementMonitor_SignIn,
} from "@/services/telemetry/schema";

import { AuthCardShell } from "../AuthCardShell";
import { MarshalSecureAccessIcon } from "../visuals/components/MarshalSecureAccessIcon";

interface Props {
  code: string;
  expired?: boolean;
  onRetry?: () => void | Promise<void>;
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand("copy");
    document.body.removeChild(textArea);
  }
}

export function GitHubDeviceCodeCard({ code, expired, onRetry }: Props) {
  const [copied, setCopied] = useState(false);
  useTimeout(() => setCopied(false), copied ? 2000 : null);

  const handleCopy = async () => {
    await copyToClipboard(code);
    setCopied(true);
  };

  const handleOpenBrowser = () => {
    void window.copilotAPI.openDeviceFlowPage(code);
  };

  const handleRetry = () => {
    void onRetry?.();
  };

  return (
    <AuthCardShell ariaLiveLabel={expired ? "Code expired" : "Enter this code on GitHub"}>
      <MarshalSecureAccessIcon size={48} />
      <h1 className="text-center text-2xl font-semibold text-foreground">
        {expired ? "Code expired" : "Enter this code on GitHub"}
      </h1>

      <div className="flex w-full items-center justify-between rounded-card border border-border bg-accent px-6 py-5">
        <span
          className={`font-mono text-[32px] font-bold tracking-[8px] whitespace-nowrap ${
            expired ? "text-muted-foreground line-through" : "text-foreground"
          }`}
        >
          {code}
        </span>
        {!expired && (
          <InteractiveElementMonitor_Copy callback={handleCopy}>
            {(cb) => (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={copied ? "Copied" : "Copy code"}
                onClick={cb}
              >
                {copied ? <Check className="text-green-500" /> : <Copy />}
              </Button>
            )}
          </InteractiveElementMonitor_Copy>
        )}
      </div>

      {expired ? (
        <p className="text-center text-sm text-muted-foreground">
          The code wasn&apos;t entered in time. Click below to generate a new one.
        </p>
      ) : (
        <>
          <p className="text-center text-sm text-muted-foreground">
            A browser window should have opened. Paste this code on GitHub to authorize.
          </p>

          <div className="flex items-center gap-3">
            <div
              className="size-6 animate-spin rounded-full border-2 border-border border-t-foreground"
              aria-hidden="true"
            />
            <span className="bg-linear-to-r from-foreground to-muted-foreground bg-clip-text text-sm text-transparent">
              Waiting for authorization...
            </span>
          </div>
        </>
      )}

      {expired ? (
        <InteractiveElementMonitor_SignIn callback={handleRetry}>
          {(cb) => (
            <Button
              variant="default"
              className="h-auto w-full rounded-card py-2 text-base"
              onClick={cb}
            >
              Try again
            </Button>
          )}
        </InteractiveElementMonitor_SignIn>
      ) : (
        <InteractiveElementMonitor_SignIn callback={handleOpenBrowser}>
          {(cb) => (
            <Button
              variant="default"
              className="h-auto w-full rounded-card py-2 text-base"
              onClick={cb}
            >
              Open GitHub again
            </Button>
          )}
        </InteractiveElementMonitor_SignIn>
      )}
    </AuthCardShell>
  );
}
