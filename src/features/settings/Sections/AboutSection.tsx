import { APP_NAME } from "@common/marshal-constants";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

interface AboutSectionProps {
  isOpen: boolean;
  /** Extra facts shown beside the app identity (active runtime, account, …). */
  children?: ReactNode;
}

export function AboutSection({ isOpen, children }: AboutSectionProps) {
  const { data: version } = useQuery({
    queryKey: ["app", "version"],
    queryFn: async () => {
      const result = await window.copilotAPI?.getVersion?.();
      return result?.success && result.version ? result.version : null;
    },
    enabled: isOpen,
    staleTime: Infinity,
  });

  return (
    <div
      data-testid="settings-about"
      className="relative overflow-hidden rounded-2xl border border-brand-stroke/30 bg-linear-to-br from-brand-subtle via-card to-card p-5 shadow-xs"
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <span
            aria-hidden="true"
            className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-brand-action shadow-sm ring-4 ring-brand-action/15"
          >
            <span
              className="inline-block size-6 bg-white"
              style={{
                maskImage: "url('./marshal-icon-outline.svg')",
                maskRepeat: "no-repeat",
                maskSize: "contain",
              }}
            />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="text-base font-semibold tracking-[-0.01em] text-foreground">
              {APP_NAME}
            </h3>
            <span className="text-xs text-muted-foreground" data-testid="settings-app-version">
              Version {version ?? "…"}
            </span>
          </div>
        </div>
        {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
      </div>
    </div>
  );
}

/** A small label/value pill shown inside the About card. */
export function AboutFact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/70 px-3 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </span>
  );
}
