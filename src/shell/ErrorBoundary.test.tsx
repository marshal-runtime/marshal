import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { installMockAPIs, render, screen, userEvent } from "@/test-utils";

import { ErrorBoundary } from "./ErrorBoundary";

function ThrowingComponent({ message }: { message: string }): never {
  throw new Error(message);
}

function GoodComponent() {
  return <div>All good</div>;
}

describe("ErrorBoundary", () => {
  const errorSpy = vi.spyOn(console, "error");
  let originalLocation: Location;

  beforeEach(() => {
    installMockAPIs();
    window.platform = "darwin";
    errorSpy.mockImplementation(() => {});
    originalLocation = window.location;
  });

  afterEach(() => {
    Object.defineProperty(window, "location", { value: originalLocation, writable: true });
  });

  it("renders children when no error", () => {
    render(
      <ErrorBoundary>
        <GoodComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByText("All good")).toBeInTheDocument();
  });

  it("renders fallback UI when child throws", () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent message="test crash" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText(/The app hit a problem/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("renders the ErrorHeader with app name", () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent message="test" />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/Marshal/)).toBeInTheDocument();
    expect(screen.queryByText(/Powered by/)).not.toBeInTheDocument();
  });

  it("uses light warning illustration by default", () => {
    document.documentElement.removeAttribute("data-theme");
    render(
      <ErrorBoundary>
        <ThrowingComponent message="test" />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("warning-illustration").getAttribute("src")).toContain(
      "marshal-warning-light.svg",
    );
  });

  it("uses dark warning illustration in dark mode", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    render(
      <ErrorBoundary>
        <ThrowingComponent message="test" />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("warning-illustration").getAttribute("src")).toContain(
      "marshal-warning-dark.svg",
    );
    document.documentElement.removeAttribute("data-theme");
  });

  it("calls window.location.reload on Try again click", async () => {
    const reloadMock = vi.fn<() => void>();
    Object.defineProperty(window, "location", {
      value: Object.create(originalLocation, {
        reload: { value: reloadMock, writable: true },
      }),
      writable: true,
    });
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <ThrowingComponent message="test" />
      </ErrorBoundary>,
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(reloadMock).toHaveBeenCalledOnce();
  });

  it("logs the error with [ErrorBoundary] prefix", () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent message="logged crash" />
      </ErrorBoundary>,
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[ErrorBoundary]",
      "logged crash",
      expect.objectContaining({
        error: expect.objectContaining({ message: "logged crash" }),
        componentStack: expect.any(String),
      }),
    );
  });

  it("logs crash via diagnosticsAPI.log", () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent message="telemetry crash" />
      </ErrorBoundary>,
    );
    expect(window.diagnosticsAPI!.log).toHaveBeenCalledWith({
      level: "error",
      category: "crash",
      message: expect.stringContaining("telemetry crash"),
      metadata: expect.objectContaining({
        errorStack: expect.any(String),
        componentStack: expect.any(String),
      }),
    });
  });

  it("still renders fallback UI when diagnostics log fails", () => {
    vi.mocked(window.diagnosticsAPI!.log).mockRejectedValue(new Error("IPC failed"));
    render(
      <ErrorBoundary>
        <ThrowingComponent message="ipc failure crash" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("shows Email crash report button in fallback UI", () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent message="crash" />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("send-crash-report-btn")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email crash report" })).toBeInTheDocument();
  });

  it("opens email with crash info when Email crash report is clicked", async () => {
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <ThrowingComponent message="email crash" />
      </ErrorBoundary>,
    );
    await user.click(screen.getByTestId("send-crash-report-btn"));
    expect(window.shellAPI!.openExternal).toHaveBeenCalledWith(
      expect.stringMatching(/^mailto:\?subject=/),
    );
    const url = vi.mocked(window.shellAPI!.openExternal).mock.calls[0][0];
    expect(url).toContain(encodeURIComponent("Marshal crashed"));
  });

  it("crash report email body contains simplified crash info", async () => {
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <ThrowingComponent message="body test" />
      </ErrorBoundary>,
    );
    await user.click(screen.getByTestId("send-crash-report-btn"));
    const url = vi.mocked(window.shellAPI!.openExternal).mock.calls[0][0];
    const body = decodeURIComponent(url.split("body=")[1]);
    expect(body).toContain("Marshal crashed");
    expect(body).toContain("Error:");
    expect(body).toContain("attach the following files");
    expect(body).toContain("startup-crash.log");
    expect(body).toContain("marshal-diagnostics.jsonl.old");
    // No inlined stacks or errorMessage — avoids PII and mailto truncation
    expect(body).not.toContain("Stack trace:");
    expect(body).not.toContain("Message:");
  });

  it("crash report email subject includes error name and version", async () => {
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <ThrowingComponent message="subject test" />
      </ErrorBoundary>,
    );
    await user.click(screen.getByTestId("send-crash-report-btn"));
    const url = vi.mocked(window.shellAPI!.openExternal).mock.calls[0][0];
    const subject = decodeURIComponent(url.split("subject=")[1].split("&")[0]);
    expect(subject).toContain("Crash Report");
    expect(subject).toContain("Error");
  });

  it("crash report email includes system info when available", async () => {
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <ThrowingComponent message="sysinfo test" />
      </ErrorBoundary>,
    );
    await user.click(screen.getByTestId("send-crash-report-btn"));
    const url = vi.mocked(window.shellAPI!.openExternal).mock.calls[0][0];
    const body = decodeURIComponent(url.split("body=")[1]);
    // Default mock returns version=0.0.0, platform=win32, arch=x64
    expect(body).toContain("Version: 0.0.0");
    expect(body).toContain("Platform: win32");
    expect(body).toContain("Architecture: x64");
  });

  it("opens the crash report email without a preset recipient", async () => {
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <ThrowingComponent message="recipient test" />
      </ErrorBoundary>,
    );
    await user.click(screen.getByTestId("send-crash-report-btn"));
    const url = vi.mocked(window.shellAPI!.openExternal).mock.calls[0][0];
    expect(url.startsWith("mailto:?")).toBe(true);
  });

  it("crash report email shows sanitized log path", async () => {
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <ThrowingComponent message="logpath test" />
      </ErrorBoundary>,
    );
    await user.click(screen.getByTestId("send-crash-report-btn"));
    const url = vi.mocked(window.shellAPI!.openExternal).mock.calls[0][0];
    const body = decodeURIComponent(url.split("body=")[1]);
    // Log path is sanitized via IPC (mock replaces /Users/<name> with ~)
    expect(body).toContain("Log folder:");
    expect(body).not.toContain("/Users/testuser");
  });

  it("sanitizes Windows-style log path in crash report email", async () => {
    vi.mocked(window.diagnosticsAPI!.getLogPath).mockResolvedValue({
      success: true,
      path: "C:\\Users\\testuser\\.marshal\\marshal-diagnostics.jsonl",
    });
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <ThrowingComponent message="win path test" />
      </ErrorBoundary>,
    );
    await user.click(screen.getByTestId("send-crash-report-btn"));
    const url = vi.mocked(window.shellAPI!.openExternal).mock.calls[0][0];
    const body = decodeURIComponent(url.split("body=")[1]);
    expect(body).toContain("Log folder:");
    expect(body).not.toContain("C:\\Users\\testuser");
  });

  it("crash report email body is sanitized via diagnostics IPC", async () => {
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <ThrowingComponent message="sanitize test" />
      </ErrorBoundary>,
    );
    await user.click(screen.getByTestId("send-crash-report-btn"));
    // The sanitize mock replaces /Users/<name> with ~
    // Verify sanitize was called for the crash fields
    expect(window.diagnosticsAPI!.sanitize).toHaveBeenCalled();
  });

  it("shows 'Email draft opened' only after openExternal succeeds", async () => {
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <ThrowingComponent message="crash" />
      </ErrorBoundary>,
    );
    await user.click(screen.getByTestId("send-crash-report-btn"));
    expect(await screen.findByRole("button", { name: "Email draft opened" })).toBeInTheDocument();
  });

  it("shows error message when openExternal fails", async () => {
    vi.mocked(window.shellAPI!.openExternal).mockResolvedValue({
      success: false,
      error: "failed",
    });
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <ThrowingComponent message="crash" />
      </ErrorBoundary>,
    );
    await user.click(screen.getByTestId("send-crash-report-btn"));
    expect(screen.getByText(/couldn't open your mail app/i)).toBeInTheDocument();
    expect(screen.getByText(/usual support channel/i)).toBeInTheDocument();
  });

  it("does not leak raw PII when sanitize IPC fails", async () => {
    const user = userEvent.setup();
    vi.mocked(window.diagnosticsAPI!.sanitize).mockRejectedValue(new Error("IPC dead"));
    render(
      <ErrorBoundary>
        <ThrowingComponent message="secret at /Users/realname/project" />
      </ErrorBoundary>,
    );
    await user.click(screen.getByTestId("send-crash-report-btn"));
    const url = vi.mocked(window.shellAPI!.openExternal).mock.calls[0][0];
    const body = decodeURIComponent(url.split("body=")[1]);
    expect(body).not.toContain("/Users/realname");
    expect(body).toContain("[sanitization unavailable]");
  });

  it("shows Email draft opened on successful openExternal", async () => {
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <ThrowingComponent message="success test" />
      </ErrorBoundary>,
    );
    await user.click(screen.getByTestId("send-crash-report-btn"));
    expect(screen.getByText(/email draft opened/i)).toBeInTheDocument();
  });
});
