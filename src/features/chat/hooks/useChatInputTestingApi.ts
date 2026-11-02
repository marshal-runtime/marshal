// File ownership: chat input test bridge.

/**
 * Test-only window API for ChatPanel tests; the mode guard strips it from
 * production builds. Exposing the imperative setter on `window` avoids
 * threading a ref through every test wrapper.
 */

import { useEffect } from "react";

declare global {
  interface Window {
    __chatInputTestApi?: {
      setInput: (text: string) => void;
      clear: () => void;
    };
  }
}

export function useChatInputTestApi(setInputAndEditor: (text: string) => void) {
  useEffect(() => {
    if (import.meta.env.MODE !== "test") return undefined;
    window.__chatInputTestApi = {
      setInput: (text: string) => setInputAndEditor(text),
      clear: () => setInputAndEditor(""),
    };
    return () => {
      delete window.__chatInputTestApi;
    };
  }, [setInputAndEditor]);
}
