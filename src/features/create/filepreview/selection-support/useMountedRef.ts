// Marshal-owned module.
import { useEffect, useRef, type MutableRefObject } from "react";

/**
 * Ref that tracks whether the host component is still mounted. Use this
 * to guard async callbacks (e.g. clipboard reads) that may resolve after
 * the component unmounts.
 *
 * The setup body re-arms `current = true` so React Strict Mode's dev-only
 * setup → cleanup → setup double-fire leaves the ref `true`, not `false`.
 * Without this re-arm, the first cleanup flips `current` to `false` and no
 * subsequent setup restores it, silently breaking every guarded async path
 * in dev. The bug is invisible in prod (no double-fire there).
 */
export function useMountedRef(): MutableRefObject<boolean> {
  const ref = useRef(true);
  useEffect(() => {
    ref.current = true;
    return () => {
      ref.current = false;
    };
  }, []);
  return ref;
}
