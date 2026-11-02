import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MSettings } from "@/types/electron";

import { SettingsRow } from "../SettingsRow";

const RETENTION_OPTIONS = [
  { value: "30", label: "30 days" },
  { value: "60", label: "60 days" },
  { value: "90", label: "90 days" },
  { value: "180", label: "180 days" },
  { value: "365", label: "1 year" },
  { value: "0", label: "Never" },
];

interface SessionRetentionSectionProps {
  settings: MSettings;
  onSaveSettings: (updated: MSettings) => void;
}

export function SessionRetentionSection({
  settings,
  onSaveSettings,
}: SessionRetentionSectionProps) {
  const currentValue = String(settings.sessionRetentionDays ?? 90);

  return (
    <SettingsRow
      label="Auto-delete sessions after"
      description="Sessions older than this are deleted on startup."
    >
      <Select
        value={currentValue}
        onValueChange={(value) =>
          onSaveSettings({ ...settings, sessionRetentionDays: Number(value) })
        }
      >
        <SelectTrigger className="w-[228px] rounded-xl">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RETENTION_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}
