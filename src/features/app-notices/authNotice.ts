import { getRuntimeMetadata } from "@common/runtime-config";

import type { AppNotice } from "./appNotice";

type AuthNoticeOptions = {
  error: string;
  runtimeId: string;
  onSignOut: () => void;
};

export function buildAuthNotice({ error, runtimeId, onSignOut }: AuthNoticeOptions): AppNotice {
  const runtime = getRuntimeMetadata(runtimeId);
  const runtimeName = runtime.auth.surface === "copilot" ? "Copilot" : runtime.displayName;
  const normalizedError = error.toLowerCase();
  const accessRejected =
    normalizedError.includes("401") ||
    normalizedError.includes("403") ||
    normalizedError.includes("unauthorized");

  return {
    id: `auth:${runtimeId}`,
    source: "auth",
    severity: "blocking",
    icon: "auth",
    title: accessRejected ? `${runtimeName} sign-in expired` : `${runtimeName} connection failed`,
    body: accessRejected
      ? "Reconnect to keep using Marshal."
      : "Sign out and reconnect to keep using Marshal.",
    details: accessRejected ? undefined : error,
    actions: [
      {
        id: "sign-out",
        label: "Sign out",
        tone: "destructive",
        onAction: onSignOut,
      },
    ],
  };
}
