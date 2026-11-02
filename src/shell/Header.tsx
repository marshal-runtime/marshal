import { APP_HEADER_TITLE } from "@common/marshal-constants";

import {
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { AIInvestigatorButton } from "@/features/ai-investigator/AIInvestigatorButton";
import { TelemetryPath_Feedback, TelemetryPath_Header } from "@/services/telemetry/schema";
import { useLayout } from "@/shared/contexts/useMarshalLayout";

import { AppModeBadge } from "./branding/AppModeBadge";
import { DRAG_STYLE, NO_DRAG_STYLE } from "./chrome/drag-styles";
import { HeaderWindowControls } from "./chrome/HeaderWindowControls";
import { useAppMode } from "./useMarshalAppMode";
import { useWindowState } from "./windowing/use-window-state";

interface HeaderProps {
  showChatToggle?: boolean;
  showSidebarToggle?: boolean;
  showNavigation?: boolean;
  /** Optional subtitle, e.g. session name in popouts. */
  subtitle?: string;
  onGoBack?: () => void;
  onGoForward?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export function Header({
  showChatToggle,
  showSidebarToggle = true,
  showNavigation,
  subtitle,
  onGoBack,
  onGoForward,
  canGoBack,
  canGoForward,
}: HeaderProps) {
  const isMac = window.platform === "darwin";
  const { sidebarCollapsed, chatCollapsed, toggleSidebar, toggleChat } = useLayout();
  const { isFullScreen } = useWindowState();
  const appMode = useAppMode();

  return (
    <TelemetryPath_Header>
      <header
        className="relative flex h-12 items-center border-b border-border bg-background px-2.5 select-none"
        style={DRAG_STYLE}
      >
        <div className="z-10 flex items-center gap-1" style={NO_DRAG_STYLE}>
          {isMac && (
            <div
              data-testid="traffic-light-spacer"
              className={`shrink-0 transition-[width] duration-200 ease-in-out ${
                isFullScreen ? "w-0" : "w-18"
              }`}
            />
          )}
          {showSidebarToggle && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleSidebar}
              title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </Button>
          )}
          {showNavigation && (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onGoBack}
                disabled={!canGoBack}
                title="Go to previous page"
                aria-label="Go to previous page"
              >
                <ChevronLeft size={16} />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onGoForward}
                disabled={!canGoForward}
                title="Go to next page"
                aria-label="Go to next page"
              >
                <ChevronRight size={16} />
              </Button>
            </>
          )}
        </div>
        <div className="pointer-events-none absolute inset-x-0 flex justify-center">
          <span className="inline-flex items-center gap-1 text-sm font-semibold text-foreground">
            {APP_HEADER_TITLE}
            <AppModeBadge mode={appMode} />
            {subtitle && (
              <span className="font-normal text-foreground-secondary"> - {subtitle}</span>
            )}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1.5" style={NO_DRAG_STYLE}>
          {showChatToggle && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleChat}
              title={chatCollapsed ? "Show chat" : "Hide chat"}
            >
              {chatCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
            </Button>
          )}
          <TelemetryPath_Feedback>
            <AIInvestigatorButton />
          </TelemetryPath_Feedback>
          <HeaderWindowControls />
        </div>
      </header>
    </TelemetryPath_Header>
  );
}
