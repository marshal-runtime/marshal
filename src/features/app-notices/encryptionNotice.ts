import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { AppNotice } from "./appNotice";

export function buildEncryptionResetNotice(onDismiss: () => void): AppNotice {
  return {
    id: "encryption-reset",
    source: "encryption-reset",
    severity: "danger",
    icon: "shield",
    title: "Local history was reset",
    body: "Secure storage changed on this device.",
    details: "This happens after a machine reprovision or OS reinstall.",
    dismiss: { onDismiss },
  };
}

export function useEncryptionResetNotice(): AppNotice | null {
  const [dismissed, setDismissed] = useState(false);
  const { data: wasKeyReset = false } = useQuery({
    queryKey: ["encryption", "wasKeyReset"],
    queryFn: () => window.encryptionAPI!.wasKeyReset(),
    enabled: !!window.encryptionAPI,
    staleTime: Infinity,
    retry: false,
  });

  if (!wasKeyReset || dismissed) return null;
  return buildEncryptionResetNotice(() => setDismissed(true));
}
