// Marshal-owned module.
/** Type for startViewTransition result */
interface ViewTransitionLike {
  finished: Promise<void>;
}

const mqSupported = typeof window !== "undefined" && typeof window.matchMedia === "function";

/**
 * Wrap a DOM mutation in a View Transition (default cross-fade).
 * Falls back to calling the callback directly when unsupported or
 * when the user prefers reduced motion.
 */
export function withViewTransition(callback: () => void): ViewTransitionLike | undefined {
  const supportsVT = typeof document !== "undefined" && "startViewTransition" in document;
  const prefersReduced =
    mqSupported && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!supportsVT || prefersReduced) {
    callback();
    return undefined;
  }

  return (document as unknown as { startViewTransition: (cb: () => void) => ViewTransitionLike }) // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- View Transitions API not in TS DOM types
    .startViewTransition(callback);
}
