import type {
  RuntimeAccountView,
  RuntimeAccountsView,
  RuntimeAuthLoginRequest,
  RuntimeAuthLoginState,
} from "@common/marshal-ipc-contract";
import { useState, type FormEvent } from "react";

import { Input } from "@/components/marshal-ui/input";
import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface AccountSignInDialogProps {
  runtime: RuntimeAccountsView;
  account: RuntimeAccountView;
  open: boolean;
  /** Set while the runtime waits for a browser or device-code step. */
  pendingState?: Extract<RuntimeAuthLoginState, { status: "pending" }>;
  submitting: boolean;
  error?: string;
  onOpenChange: (open: boolean) => void;
  onLogin: (request: RuntimeAuthLoginRequest) => void;
}

export function AccountSignInDialog({
  runtime,
  account,
  open,
  pendingState,
  submitting,
  error,
  onOpenChange,
  onLogin,
}: AccountSignInDialogProps) {
  const [apiKey, setApiKey] = useState("");
  const apiKeyMethod = runtime.authMethods.find((method) => method.type === "api-key");
  const interactiveMethods = runtime.authMethods.filter(
    (method): method is { type: "browser" | "device-code"; label: string } =>
      method.type !== "api-key",
  );
  const verificationUri = pendingState?.verificationUri;
  const title = `Sign in ${account.label} to ${runtime.displayName}`;

  const submitApiKey = (event: FormEvent) => {
    event.preventDefault();
    const value = apiKey.trim();
    if (!value) return;
    setApiKey("");
    onLogin({ type: "api-key", apiKey: value });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {pendingState
              ? pendingState.method === "device-code"
                ? "Enter this code on the verification page. This dialog closes once you are signed in."
                : "Finish signing in in your browser. This dialog closes once you are signed in."
              : submitting
                ? "Finish signing in in your browser. Use the account you want this entry to run as."
                : "Sessions on this account use its own sign-in. Use the account you want this entry to run as."}
          </DialogDescription>
        </DialogHeader>
        {pendingState ? (
          <div className="flex flex-col items-center gap-3">
            {pendingState.userCode && (
              <code className="rounded-md bg-muted px-4 py-2 text-lg font-semibold tracking-widest">
                {pendingState.userCode}
              </code>
            )}
            {verificationUri && (
              <Button
                className="w-full"
                onClick={() => void window.shellAPI?.openExternal(verificationUri)}
              >
                Open sign-in page
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {interactiveMethods.map((method) => (
              <Button
                key={method.type}
                disabled={submitting}
                onClick={() => onLogin({ type: method.type })}
              >
                {submitting ? "Waiting for sign-in…" : method.label}
              </Button>
            ))}
            {apiKeyMethod && (
              <form className="flex flex-col gap-2" onSubmit={submitApiKey}>
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`${runtime.displayName} API key`}
                  placeholder="API key"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <Button type="submit" variant="outline" disabled={submitting || !apiKey.trim()}>
                  {apiKeyMethod.label}
                </Button>
              </form>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {pendingState ? "Close" : "Cancel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
