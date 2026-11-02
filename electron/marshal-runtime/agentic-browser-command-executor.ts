import { randomUUID } from "node:crypto";

import { setCDPHost } from "./agentic-browser-owned/cdp";
import * as browser from "./agentic-browser-owned/commands";
import { checkConnection, launchBrowser, shutdownBrowser } from "./agentic-browser-owned/launcher";
import type {
  MarshalRuntimeBrowserCommandExecutorPort,
  MarshalRuntimeBrowserCommandRequest,
  MarshalRuntimeBrowserCommandResult,
} from "./browser-command-executor";

/** Direct, in-process adapter for the Agentic Browser CDP implementation. */
export class AgenticBrowserCommandExecutor implements MarshalRuntimeBrowserCommandExecutorPort {
  private readonly port: number;
  private ready: Promise<void> | undefined;

  constructor(
    port = 9222,
    private readonly userDataDir?: string,
    private readonly seedUserDataDir?: string,
    private readonly profile?: string,
  ) {
    this.port = port;
    setCDPHost("127.0.0.1");
  }

  async execute(
    request: MarshalRuntimeBrowserCommandRequest,
  ): Promise<MarshalRuntimeBrowserCommandResult> {
    const startedAt = Date.now();
    await this.ensureBrowser();
    const input = request.input;
    browser.setTargetOverride(optionalString(input.targetId));
    const result = await this.invoke(request.command, input);
    return {
      success: result.success,
      ...(result.success
        ? { data: result }
        : {
            error: {
              code: "AGENTIC_BROWSER_ERROR",
              message:
                typeof result.error === "string" ? result.error : "Agentic Browser command failed",
              details: result,
            },
          }),
      metadata: {
        duration: Date.now() - startedAt,
        timestamp: Date.now(),
        commandId: randomUUID(),
        context: request.context,
      },
    };
  }

  async dispose(): Promise<void> {
    // Browser lifetime intentionally outlives a Runtime host restart so a chat
    // can retain tabs and authenticated profile state.
  }

  private async ensureBrowser(): Promise<void> {
    if (await checkConnection(this.port)) return;
    this.ready ??= launchBrowser({
      port: this.port,
      userDataDir: this.userDataDir,
      seedUserDataDir: this.seedUserDataDir,
      profile: this.profile,
    }).then(() => undefined);
    try {
      await this.ready;
    } finally {
      this.ready = undefined;
    }
  }

  private invoke(
    command: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown> & { success: boolean }> {
    const selector = optionalString(input.selector) ?? optionalString(input.ref);
    switch (command) {
      case "browser_navigate":
        return browser.navigate(this.port, requiredString(input.url));
      case "browser_click":
        return browser.click(
          this.port,
          selector,
          optionalButton(input.button),
          optionalNumber(input.x),
          optionalNumber(input.y),
          input.doubleClick === true ? 2 : 1,
          browser.parseModifierFlags(optionalString(input.modifiers)),
        );
      case "browser_type":
        return selector
          ? browser.type(
              this.port,
              selector,
              requiredString(input.text),
              input.clearFirst !== false,
            )
          : browser.typeAtCursor(this.port, requiredString(input.text));
      case "browser_select":
        return browser.select(
          this.port,
          requiredString(selector),
          optionalString(input.value),
          optionalString(input.label),
          optionalNumber(input.index),
        );
      case "browser_hover":
        return browser.hover(this.port, requiredString(selector));
      case "browser_go_back":
        return browser.goBack(this.port);
      case "browser_screenshot":
        return browser.screenshot(this.port, {
          fullPage: input.fullPage === true,
          format: optionalString(input.format),
        });
      case "browser_accessibility_tree":
        return browser.accessibilityTree(this.port, optionalNumber(input.maxDepth));
      case "browser_create_tab":
        return browser.createTab(this.port, optionalString(input.url));
      case "browser_close_tab":
        return browser.closeTab(this.port, requiredString(input.targetId));
      case "browser_switch_tab":
        return browser.switchTab(this.port, requiredString(input.targetId));
      case "browser_list_tabs":
        return browser.listTabs(this.port);
      case "browser_execute_script":
        return browser.executeScript(this.port, requiredString(input.script));
      case "browser_console":
        return browser.executeConsole(this.port, requiredString(input.command));
      case "browser_file_upload":
        return browser.uploadFile(
          this.port,
          requiredString(selector),
          stringArray(input.filePaths),
        );
      case "browser_get_html":
        return browser.getHtml(this.port, selector);
      case "browser_keyboard":
        return browser.pressKey(this.port, requiredString(input.key));
      case "browser_scroll":
        return browser.scroll(
          this.port,
          optionalNumber(input.x) ?? 0,
          optionalNumber(input.y) ?? 0,
          selector,
        );
      case "browser_reload":
        return browser.reload(this.port, input.hard === true);
      case "browser_go_forward":
        return browser.goForward(this.port);
      case "browser_wait_for_selector":
        return browser.waitForSelector(
          this.port,
          requiredString(selector),
          "visible",
          optionalNumber(input.timeout),
        );
      case "browser_wait_for_navigation":
        return browser.waitForNavigation(this.port, optionalNumber(input.timeout));
      case "browser_wait_for_network_idle":
        return browser.waitForNetworkIdle(this.port, optionalNumber(input.timeout));
      case "browser_get_metadata":
        return browser.getMetadata(this.port);
      case "browser_profile_info":
        return browser.profileInfo(this.port);
      case "browser_list_targets":
        return import("./agentic-browser-owned/cdp").then(async ({ listTargets }) => ({
          success: true,
          targets: await listTargets(this.port),
        }));
      case "browser_extract_data":
        return browser.extractData(this.port, requiredString(input.type), selector);
      case "browser_wait_for_condition":
        return browser.waitForCondition(
          this.port,
          requiredString(input.expression),
          optionalNumber(input.timeout),
        );
      case "browser_get_storage":
        return browser.getCookies(this.port, optionalString(input.domain));
      case "browser_modify_css":
        return browser.injectCSS(this.port, requiredString(input.css));
      case "browser_modify_html":
        return browser.insertHTML(
          this.port,
          requiredString(selector),
          requiredString(input.html),
          optionalPosition(input.position),
        );
      case "browser_shutdown":
        shutdownBrowser(this.port);
        return Promise.resolve({ success: true });
      default:
        return Promise.resolve({
          success: false,
          error: `Unsupported Agentic Browser command: ${command}`,
        });
    }
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function requiredString(value: unknown): string {
  const result = optionalString(value);
  if (!result) throw new Error("Agentic Browser requires a non-empty string input.");
  return result;
}
function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function optionalButton(value: unknown): "left" | "right" | "middle" {
  return value === "right" || value === "middle" ? value : "left";
}
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error("Agentic Browser requires a string array.");
  return value;
}
function optionalPosition(value: unknown): "beforebegin" | "afterbegin" | "beforeend" | "afterend" {
  return value === "beforebegin" || value === "afterbegin" || value === "afterend"
    ? value
    : "beforeend";
}
