import { type LexicalEditor } from "lexical";
import { useMemo } from "react";

import {
  $findLeadingSkillPill,
  $insertSkillPillAtStart,
  $removeLeadingSkillPill,
} from "../pills/pill-type-guards";

export interface SkillCommands {
  setSkill(skillName: string, skillId: string): void;
  clearSkill(): void;
  getSkill(): { name: string; id: string } | null;
}

export function useSkillCommands(editor: LexicalEditor): SkillCommands {
  return useMemo(
    () => ({
      setSkill(skillName: string, skillId: string) {
        editor.update(() => {
          $insertSkillPillAtStart(skillName, skillId);
        });
      },
      clearSkill() {
        editor.update(() => {
          $removeLeadingSkillPill();
        });
      },
      getSkill() {
        let result: { name: string; id: string } | null = null;
        editor.getEditorState().read(() => {
          const pill = $findLeadingSkillPill();
          if (pill) result = { name: pill.getSkillName(), id: pill.getSkillId() };
        });
        return result;
      },
    }),
    [editor],
  );
}
