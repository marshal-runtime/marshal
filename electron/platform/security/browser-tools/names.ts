export const PLAYWRIGHT_EXPLICIT_WRITE_TOOLS: Record<string, string> = {
  browser_take_screenshot: "filename",
  browser_pdf_save: "filename",
  browser_snapshot: "filename",
  browser_console_messages: "filename",
  browser_network_requests: "filename",
  browser_stop_video: "filename",
};

export const PLAYWRIGHT_CODE_EXECUTION_TOOLS = [
  "browser_evaluate",
  "browser_run_code",
  "browser_run_code_unsafe",
] as const;

export function getBarePlaywrightToolName(toolName: string): string {
  const lower = toolName.toLowerCase();
  if (lower.startsWith("playwright-")) return lower.slice("playwright-".length);
  if (lower.startsWith("playwright__")) return lower.slice("playwright__".length);
  return lower;
}

export function isBrowserCodeExecutionTool(toolName: string): boolean {
  return (PLAYWRIGHT_CODE_EXECUTION_TOOLS as readonly string[]).includes(toolName);
}
