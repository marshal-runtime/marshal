import type { RuntimeAuthLoginRequest } from "@common/marshal-ipc-contract";
import type { RuntimeAuthMethodMetadata } from "@common/runtime-config";
import { useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/marshal-ui/marshal-button";
import { Input } from "@/components/marshal-ui/input";

import { AuthCardShell } from "../AuthCardShell";
import { MarshalSecureAccessIcon } from "../visuals/components/MarshalSecureAccessIcon";
import { RuntimeSwitchDialog } from "./RuntimeSwitchDialog";
import type { UseRuntimeAuthResult } from "./useRuntimeAuth";

interface RuntimeAuthGateProps {
  auth: UseRuntimeAuthResult;
  children: ReactNode;
}

export function RuntimeAuthGate({ auth, children }: RuntimeAuthGateProps) {
  const { metadata, stage } = auth;
  const [runtimeSwitchOpen, setRuntimeSwitchOpen] = useState(false);
  const withRuntimeSwitch = (content: ReactNode) => (
    <>
      {content}
      {runtimeSwitchOpen && (
        <RuntimeSwitchDialog
          currentRuntimeId={metadata.id}
          open
          onOpenChange={setRuntimeSwitchOpen}
        />
      )}
    </>
  );

  switch (stage.kind) {
    case "ready":
      return children;
    case "checking":
      return (
        <AuthCardShell
          ariaLiveLabel={`Checking ${metadata.displayName} authentication`}
          paddingY="10"
        >
          <div
            className="size-7 animate-spin rounded-full border-2 border-border border-t-foreground"
            aria-hidden="true"
          />
          <p className="text-foreground">Checking {metadata.displayName} authentication...</p>
        </AuthCardShell>
      );
    case "setup-required":
      return withRuntimeSwitch(
        <RuntimeAuthMessageCard
          title={`Set up ${metadata.displayName}`}
          message={stage.message}
          secondaryActionLabel="Change runtime"
          onSecondaryAction={() => setRuntimeSwitchOpen(true)}
        />,
      );
    case "error":
      return withRuntimeSwitch(
        <RuntimeAuthMessageCard
          title={`${metadata.displayName} authentication failed`}
          message={stage.message}
          actionLabel="Try again"
          onAction={auth.retry}
          secondaryActionLabel="Change runtime"
          onSecondaryAction={() => setRuntimeSwitchOpen(true)}
        />,
      );
    case "sign-in":
      return withRuntimeSwitch(
        <RuntimeSignInCard
          displayName={metadata.displayName}
          methods={stage.methods}
          message={stage.message}
          error={stage.error}
          pending={auth.isLoginPending}
          onLogin={auth.login}
          onChangeRuntime={() => setRuntimeSwitchOpen(true)}
        />,
      );
    case "pending":
      return withRuntimeSwitch(
        <RuntimePendingAuthCard
          displayName={metadata.displayName}
          method={stage.method}
          verificationUri={stage.verificationUri}
          userCode={stage.userCode}
          onChangeRuntime={() => setRuntimeSwitchOpen(true)}
        />,
      );
  }
  stage satisfies never;
  return null;
}

function RuntimeAuthMessageCard({
  title,
  message,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
}: {
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
}) {
  return (
    <AuthCardShell ariaLiveLabel={title} width="420">
      <MarshalSecureAccessIcon size={48} />
      <div className="flex w-full flex-col items-center gap-3 text-center text-foreground">
        <h1 className="text-2xl/[1.2] font-semibold">{title}</h1>
        <p className="text-sm/normal">{message}</p>
      </div>
      {actionLabel && onAction && (
        <Button className="w-full" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
      {secondaryActionLabel && onSecondaryAction && (
        <Button className="w-full" variant="outline" onClick={onSecondaryAction}>
          {secondaryActionLabel}
        </Button>
      )}
    </AuthCardShell>
  );
}

function RuntimeSignInCard({
  displayName,
  methods,
  message,
  error,
  pending,
  onLogin,
  onChangeRuntime,
}: {
  displayName: string;
  methods: UseRuntimeAuthResult["metadata"]["auth"]["methods"];
  message?: string;
  error?: string;
  pending: boolean;
  onLogin: (request: RuntimeAuthLoginRequest) => void;
  onChangeRuntime: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const apiKeyMethod = methods.find((method) => method.type === "api-key");
  const interactiveMethods = methods.filter(
    (method): method is RuntimeAuthMethodMetadata & { type: "browser" | "device-code" } =>
      method.type !== "api-key",
  );

  const submitApiKey = (event: FormEvent) => {
    event.preventDefault();
    const value = apiKey.trim();
    if (!value) return;
    setApiKey("");
    onLogin({ type: "api-key", apiKey: value });
  };

  return (
    <AuthCardShell ariaLiveLabel={`Sign in to ${displayName}`} width="420">
      <MarshalSecureAccessIcon size={48} />
      <div className="flex w-full flex-col items-center gap-3 text-center text-foreground">
        <h1 className="text-2xl/[1.2] font-semibold">Sign in to {displayName}</h1>
        <p className="text-sm leading-[1.4]">
          {message ?? "Choose an authentication method to continue."}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-center text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex w-full flex-col gap-3">
        {interactiveMethods.map((method) => (
          <Button
            key={method.type}
            disabled={pending}
            onClick={() => onLogin({ type: method.type })}
          >
            {method.label}
          </Button>
        ))}
        {apiKeyMethod && (
          <form className="flex w-full flex-col gap-2" onSubmit={submitApiKey}>
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={`${displayName} API key`}
              placeholder="API key"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <Button type="submit" variant="outline" disabled={pending || !apiKey.trim()}>
              {apiKeyMethod.label}
            </Button>
          </form>
        )}
        <Button variant="outline" disabled={pending} onClick={onChangeRuntime}>
          Change runtime
        </Button>
      </div>
    </AuthCardShell>
  );
}

function RuntimePendingAuthCard({
  displayName,
  method,
  verificationUri,
  userCode,
  onChangeRuntime,
}: {
  displayName: string;
  method: "browser" | "device-code";
  verificationUri?: string;
  userCode?: string;
  onChangeRuntime: () => void;
}) {
  const openVerificationPage = () => {
    if (verificationUri) void window.shellAPI?.openExternal(verificationUri);
  };

  return (
    <AuthCardShell ariaLiveLabel={`Waiting for ${displayName} authentication`} width="420">
      <div
        className="size-7 animate-spin rounded-full border-2 border-border border-t-foreground"
        aria-hidden="true"
      />
      <div className="flex w-full flex-col items-center gap-3 text-center text-foreground">
        <h1 className="text-2xl/[1.2] font-semibold">Finish signing in to {displayName}</h1>
        <p className="text-sm leading-[1.4]">
          {method === "device-code"
            ? "Enter this code on the verification page."
            : "Complete authentication in your browser."}
        </p>
        {userCode && (
          <code className="rounded-md bg-muted px-4 py-2 text-lg font-semibold tracking-widest">
            {userCode}
          </code>
        )}
      </div>
      {verificationUri && (
        <Button className="w-full" onClick={openVerificationPage}>
          Open sign-in page
        </Button>
      )}
      <Button className="w-full" variant="outline" onClick={onChangeRuntime}>
        Change runtime
      </Button>
    </AuthCardShell>
  );
}
