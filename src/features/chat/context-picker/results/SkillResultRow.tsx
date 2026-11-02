import type { Skill } from "@/types/electron";

import { ResultRowFrame } from "./ResultRowFrame";

interface SkillResultRowProps {
  skill: Skill;
}

export function SkillResultRow({ skill }: SkillResultRowProps) {
  return (
    <ResultRowFrame className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">/{skill.name}</span>
        {skill.scope === "global" && (
          <span className="rounded-sm bg-muted px-1 py-0.5 text-[10px]">Global</span>
        )}
      </div>
      <span className="truncate text-xs text-muted-foreground">{skill.description}</span>
    </ResultRowFrame>
  );
}
