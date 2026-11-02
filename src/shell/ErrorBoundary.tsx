import { APP_NAME } from "@common/marshal-constants";
import { createLogger } from "@common/marshal-logger";
import { crashErrors, makeCrashError } from "@common/telemetry/errors/marshal-crash";
import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/marshal-ui/marshal-button";
import { diagnosticLog } from "@/services/marshal-diagnostic-logger";
import { logErrorForCrash } from "@/services/telemetry/error-routing";
import { useDocumentTheme } from "@/shared/hooks/useTheme";

import { DRAG_STYLE, NO_DRAG_STYLE } from "./chrome/drag-styles";
import { HeaderWindowControls } from "./chrome/HeaderWindowControls";

const log = createLogger("ErrorBoundary");

/**
 * Simplified header for the error fallback screen.
 * The real Header can't be used because it depends on LayoutProvider and TelemetryProvider,
 * which live inside the crashed tree.
 */
function ErrorHeader() {
  const isMac = window.platform === "darwin";

  return (
    <header
      className="relative flex h-12 shrink-0 items-center border-b border-border bg-background px-4 select-none"
      style={DRAG_STYLE}
    >
      {isMac && <div className="w-[70px]" />}
      <div className="pointer-events-none absolute inset-x-0 flex justify-center">
        <span className="text-sm font-semibold text-foreground">{APP_NAME}</span>
      </div>
      <div className="ml-auto flex items-center" style={NO_DRAG_STYLE}>
        <HeaderWindowControls />
      </div>
    </header>
  );
}

function ErrorFallback({
  onRetry,
  onSendReport,
  reportSent,
  reportFailed,
}: {
  onRetry: () => void;
  onSendReport: () => void;
  reportSent: boolean;
  reportFailed: boolean;
}) {
  const theme = useDocumentTheme();
  const warningSrc =
    theme === "dark" ? "./marshal-warning-dark.svg" : "./marshal-warning-light.svg";

  return (
    <div className="flex h-full flex-col bg-background">
      <ErrorHeader />
      <div className="flex flex-1 flex-col items-center justify-center p-5">
        <div role="alert" className="flex max-w-[414px] flex-col items-center gap-6">
          <h1 className="text-[28px] leading-tight font-semibold text-foreground">
            Something went wrong
          </h1>
          <img
            src={warningSrc}
            width={192}
            height={192}
            alt=""
            aria-hidden
            data-testid="warning-illustration"
          />
          <div className="flex flex-col items-center gap-4">
            <p className="text-base/relaxed text-muted-foreground">
              The app hit a problem. Try again, or email a crash report if it keeps happening.
            </p>
            <div className="flex items-center gap-3">
              <Button onClick={onRetry}>Try again</Button>
              <Button
                variant="outline"
                onClick={onSendReport}
                disabled={reportSent}
                data-testid="send-crash-report-btn"
              >
                {reportSent ? "Email draft opened" : "Email crash report"}
              </Button>
            </div>
            {reportSent && (
              <p className="text-center text-sm text-muted-foreground">
                An email draft has been opened. Please attach the diagnostic files, then send the
                email.
              </p>
            )}
            {reportFailed && (
              <p className="text-center text-sm text-warning-primary">
                Couldn&apos;t open your mail app. Please report the issue through your usual support
                channel.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  reportSent: boolean;
  reportFailed: boolean;
  crashData: {
    errorName: string;
    errorMessage: string;
    errorStack: string;
    componentStack: string;
  } | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, reportSent: false, reportFailed: false, crashData: null };
  }

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { hasError: true, reportSent: false, reportFailed: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const errorName = error?.name ?? "UnknownError";
    const errorMessage = error?.message ?? String(error);
    const errorStack = error?.stack ?? "";
    const componentStack = info.componentStack ?? "";

    log.error(errorMessage, { error, componentStack });

    // Store crash data for the email report button
    this.setState({ crashData: { errorName, errorMessage, errorStack, componentStack } });

    // Write to diagnostic log file (sanitized by the logger)
    diagnosticLog.error("crash", `${errorName}: ${errorMessage}`, {
      errorStack,
      componentStack,
    });

    logErrorForCrash(makeCrashError(crashErrors.REACT_ERROR_BOUNDARY));
  }

  private handleRetry = () => {
    window.location.reload();
  };

  private handleSendReport = async () => {
    try {
      const crash = this.state.crashData;

      const sanitize = async (text: string) => {
        try {
          const result = await window.diagnosticsAPI?.sanitize(text);
          return result?.sanitized ?? "[redacted]";
        } catch {
          return "[sanitization unavailable]";
        }
      };

      const errorName = await sanitize(crash?.errorName ?? "Unknown");

      let info: { version?: string; platform?: string; arch?: string; osVersion?: string } = {};
      try {
        info = (await window.copilotAPI?.getSystemInfo()) ?? {};
      } catch {
        /* best-effort */
      }

      const versionTag = info.version ? ` (v${info.version})` : "";
      const subject = `Marshal Crash Report${versionTag}: ${errorName}`;

      // Keep email body short — full crash data is in the JSONL log file.
      // errorMessage is intentionally excluded to avoid PII leaks (user content
      // in exceptions like prompts, names, tokens may not be fully sanitized).
      const bodyParts = [
        "Marshal crashed.",
        "",
        `Error: ${errorName}`,
        "",
        "📎 Please attach the following files from the log folder to this email:",
        "  • marshal-diagnostics.jsonl",
        "  • marshal-diagnostics.jsonl.old (if it exists)",
        "  • startup-crash.log (if the crash happened during startup)",
        "",
        "If possible, describe what you were doing when the crash happened.",
      ];

      const systemLines: string[] = [
        info.version && `Version: ${info.version}`,
        info.platform && `Platform: ${info.platform}`,
        info.arch && `Architecture: ${info.arch}`,
        info.osVersion && `OS: ${info.osVersion}`,
      ].filter((line): line is string => Boolean(line));
      if (systemLines.length) {
        bodyParts.push("", "---", ...systemLines);
      }

      try {
        const logPathResult = await window.diagnosticsAPI?.getLogPath();
        if (logPathResult?.path) {
          const displayPath = await sanitize(logPathResult.path);
          bodyParts.push("", `Log folder: ${displayPath.replace(/[/\\][^/\\]+$/, "")}`);
        }
      } catch {
        /* best-effort */
      }

      const url = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyParts.join("\n"))}`;
      const result = await window.shellAPI?.openExternal(url);
      if (result?.success) {
        this.setState({ reportSent: true });
      } else {
        this.setState({ reportFailed: true });
      }
    } catch {
      this.setState({ reportFailed: true });
      log.warn("Failed to compose crash report email");
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <ErrorFallback
          onRetry={this.handleRetry}
          onSendReport={this.handleSendReport}
          reportSent={this.state.reportSent}
          reportFailed={this.state.reportFailed}
        />
      );
    }
    return (
      <>
        {!__IS_RELEASE_BUILD__ && <CrashTrigger />}
        {this.props.children}
      </>
    );
  }
}

/**
 * Invisible component that registers `window.__triggerCrash()`.
 * Calling it forces a React render error that the ErrorBoundary catches.
 * Used by E2E tests (and dev tools) to exercise the crash flow.
 */
function CrashTrigger() {
  const [shouldThrow, setShouldThrow] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test hook on window
    (window as unknown as Record<string, unknown>).__triggerCrash = () => setShouldThrow(true);
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- cleanup test hook
      delete (window as unknown as Record<string, unknown>).__triggerCrash;
    };
  }, []);

  if (shouldThrow) {
    throw new Error("Crash triggered via window.__triggerCrash()");
  }
  return null;
}

export function DevErrorTrigger() {
  const [shouldThrow, setShouldThrow] = useState(false);
  if (shouldThrow) {
    throw new Error("Dev-triggered error for ErrorBoundary testing");
  }
  if (!import.meta.env.DEV) return null;
  return (
    <Button variant="outline" size="sm" onClick={() => setShouldThrow(true)}>
      Trigger Error Boundary
    </Button>
  );
}
