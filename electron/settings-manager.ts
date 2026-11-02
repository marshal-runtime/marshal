import { EventEmitter } from "events";

import { normalizeRuntimeSelectionSettings } from "../common/marshal-default-settings";
import { normalizeProviderSelectionSettings } from "../common/provider-config";
import type { ISettingsManager } from "./backend/ports";
import type { MSettings } from "./ipc/types";
import { loadSettingsFromDisk, saveSettingsToDisk } from "./settings-store";

export class SettingsManager extends EventEmitter implements ISettingsManager {
  private settings: MSettings;

  constructor() {
    super();
    this.settings = loadSettingsFromDisk();
  }

  get(): MSettings {
    return this.settings;
  }

  save(settings: MSettings): void {
    this.settings = normalizeProviderSelectionSettings(
      normalizeRuntimeSelectionSettings(settings),
    );
    saveSettingsToDisk(this.settings);
    this.emit("changed", this.settings);
  }

  update(partial: Partial<MSettings>): void {
    this.save({ ...this.settings, ...partial });
  }
}
