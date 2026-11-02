// Marshal-owned module.
import { render } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";

import { useMountedRef } from "./useMountedRef";

/**
 * Regression pin for the `mountedRef` lifecycle used by
 * `FilePreview.tsx`'s `dispatchPartialEditFromClipboard` (FilePreview.tsx
 * ~265-272). The guard depends on `useMountedRef` re-arming
 * `current = true` in the effect's setup body so React Strict Mode (active
 * in dev via `src/main.tsx:49`) double-fires (setup → cleanup → setup)
 * leave the ref `true`, not `false`. Without the re-arm, the first cleanup
 * flips `current` to `false` and silently no-ops every subsequent
 * partial-paste dispatch in dev. Ctrl+V would work in prod, fail in dev —
 * Raised in review.
 */

describe("mountedRef under React.StrictMode (FilePreview pattern)", () => {
  it("ref.current is true after StrictMode's setup → cleanup → setup double-fire", () => {
    let capturedRef: React.MutableRefObject<boolean> | null = null;

    function Probe() {
      capturedRef = useMountedRef();
      return null;
    }

    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );

    expect(capturedRef).not.toBeNull();
    // Under the buggy cleanup-only pattern this would be `false`: the first
    // mount's cleanup ran, the second mount's setup did nothing to re-arm.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(capturedRef!.current).toBe(true);
  });

  it("ref.current flips to false on real unmount", () => {
    let capturedRef: React.MutableRefObject<boolean> | null = null;

    function Probe() {
      capturedRef = useMountedRef();
      return null;
    }

    const { unmount } = render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    unmount();

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(capturedRef!.current).toBe(false);
  });
});
