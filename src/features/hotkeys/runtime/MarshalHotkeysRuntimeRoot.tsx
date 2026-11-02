// Renderer-owned hotkeys provider boundary.
import { HotkeysProvider } from "@tanstack/react-hotkeys";
import type { ReactNode } from "react";

interface HotkeysRootProps {
  children: ReactNode;
}

export function HotkeysRoot({ children }: HotkeysRootProps) {
  return (
    <HotkeysProvider
      defaultOptions={{
        hotkeyRecorder: {
          ignoreInputs: false,
        },
      }}
    >
      {children}
    </HotkeysProvider>
  );
}
