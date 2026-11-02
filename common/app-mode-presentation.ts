import { type AppMode } from "./marshal-constants";

const APP_MODE_BRANDING: Record<AppMode, { label: string; badgeText: string; assetMode: AppMode }> =
  {
    dev: { assetMode: "dev", label: "Dev", badgeText: "DEV" },
    beta: { assetMode: "beta", label: "Beta", badgeText: "BETA" },
    release: { assetMode: "release", label: "", badgeText: "" },
  };

export function getAppModeAssetMode(mode: AppMode): AppMode {
  return APP_MODE_BRANDING[mode].assetMode;
}

export function getAppModeLabel(mode: AppMode): string {
  return APP_MODE_BRANDING[mode].label;
}

export function getAppModeBadgeText(mode: AppMode): string {
  return APP_MODE_BRANDING[mode].badgeText;
}
