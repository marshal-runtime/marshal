import { useRef } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ThemeMode } from "@/app-theme";

import { SettingsRow } from "../SettingsRow";

interface AppearanceSectionProps {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode, originEl?: HTMLElement | null) => void;
}

export function AppearanceSection({ theme, onThemeChange }: AppearanceSectionProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const options: Array<{ value: ThemeMode; label: string }> = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];

  return (
    <SettingsRow label="Theme">
      <Select
        value={theme || "system"}
        onValueChange={(value) => {
          const selected = options.find((option) => option.value === value);
          if (selected) onThemeChange(selected.value, triggerRef.current);
        }}
      >
        <SelectTrigger ref={triggerRef} className="w-[228px] rounded-xl">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}
