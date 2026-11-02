import { cn } from "@/lib/marshal-class-names";

import type { SkillMenuOption } from "../editor/plugins/SkillTypeaheadPlugin";

interface SkillCommandPaletteProps {
  options: SkillMenuOption[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (option: SkillMenuOption) => void;
}

export function SkillCommandPalette({
  options,
  selectedIndex,
  onHover,
  onSelect,
}: SkillCommandPaletteProps) {
  if (options.length === 0) return null;
  return (
    <div
      data-testid="skill-command-palette"
      className="absolute bottom-full left-0 z-10 mb-2 max-h-72 w-full min-w-[18rem] overflow-y-auto rounded-xl border border-border/80 bg-popover/95 p-1.5 shadow-lg ring-1 ring-foreground/5 backdrop-blur-sm"
    >
      {options.map((option, index) => (
        <div
          key={option.skill.id}
          ref={option.setRefElement}
          role="option"
          aria-selected={index === selectedIndex}
          data-selected={index === selectedIndex}
          className={cn(
            "flex w-full cursor-pointer flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors",
            index === selectedIndex
              ? "bg-primary/10 text-foreground ring-1 ring-primary/20"
              : "hover:bg-muted/80",
          )}
          onClick={() => onSelect(option)}
          onMouseEnter={() => onHover(index)}
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">/{option.skill.name}</span>
            {option.skill.scope === "global" && (
              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                Global
              </span>
            )}
          </div>
          <span className="truncate text-xs text-muted-foreground">{option.skill.description}</span>
        </div>
      ))}
    </div>
  );
}
