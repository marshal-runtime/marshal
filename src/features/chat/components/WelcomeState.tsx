import type { UserIdentity } from "@common/marshal-ipc-contract";
import { useState } from "react";

import { TelemetryPath_WelcomeState } from "@/services/telemetry/schema";
import { useIdentity } from "@/shared/hooks/useIdentity";

// Rotating greeting templates. Picked once per mount (i.e. per app start or
// new-chat) so the line feels fresh but doesn't jitter mid-session.
const GREETING_TEMPLATES: Array<(name: string) => string> = [
  (name) => `What are we working on today, ${name}?`,
  (name) => `${name}, what are we working on?`,
  (name) => `Where should we start, ${name}?`,
];

function firstName(identity: UserIdentity): string {
  if (!identity.isAuthenticated || !identity.displayName) return "there";
  const first = identity.displayName.trim().split(/\s+/)[0];
  return first || "there";
}

export function WelcomeState() {
  const identity = useIdentity();
  const name = firstName(identity);

  // Pick once per mount (lazy init) so the greeting stays stable within a
  // session — and doesn't shuffle on every re-render. Soul change
  // creates a new session id, which remounts WelcomeState (via the keyed
  // conditional in ChatPanel) and re-rolls the template — that's
  // intentional: a new session reads as a new context.
  const [templateIndex] = useState(() => Math.floor(Math.random() * GREETING_TEMPLATES.length));
  const greeting = GREETING_TEMPLATES[templateIndex](name);

  return (
    <TelemetryPath_WelcomeState>
      {/* Roughly 1.6:1 flex-grow spacers sit the greeting a little below
          centre, close enough to the composer to read as one stack without
          leaving the top of the pane visibly empty. Spacers only consume free
          space (no min-height), so on short windows they collapse and the
          content falls back to top-aligned + scrollable. */}
      <div className="flex flex-1 flex-col">
        <div className="grow-[1.6]" aria-hidden />
        <div className="flex flex-col items-center p-6" data-testid="welcome-state">
          <h1
            // Key on the stable per-mount templateIndex, not on the greeting
            // string — otherwise the h1 remounts (and re-runs the fade-in
            // animation) every time `identity.displayName` resolves, giving
            // a visible double-animation on first load.
            key={templateIndex}
            className="animate-in text-center text-[30px] leading-[1.15] font-medium tracking-[-0.02em] text-balance text-foreground duration-700 fade-in"
            data-testid="welcome-greeting"
          >
            {greeting}
          </h1>
        </div>
        {/* Floors the bottom spacer just under the collapsed ChatInput form so
            that on short viewports the wrapper overflows just enough to scroll
            the greeting clear of the absolutely-positioned input — without
            leaving extra empty scroll space. On tall windows the natural grow
            share exceeds this floor and the min-h is a no-op. The value tracks
            the composer's collapsed height; re-measure it in the running app if
            the composer's row count or padding changes. */}
        <div className="min-h-[140px] grow" aria-hidden />
      </div>
    </TelemetryPath_WelcomeState>
  );
}
