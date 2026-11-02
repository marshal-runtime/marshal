import type { ContextPersonEntity } from "@/types/electron";

import { PersonAvatar } from "../../components/person/PersonAvatar";
import { ResultRowFrame } from "./ResultRowFrame";

interface PeopleResultRowProps {
  entity: ContextPersonEntity;
}

export function PeopleResultRow({ entity }: PeopleResultRowProps) {
  return (
    <>
      <PersonAvatar email={entity.email} displayName={entity.displayName} size={28} />
      <ResultRowFrame>
        <div className="truncate text-sm">{entity.displayName}</div>
        {(entity.email ?? entity.jobTitle) && (
          <div className="truncate text-xs text-muted-foreground">
            {entity.email ?? entity.jobTitle}
          </div>
        )}
      </ResultRowFrame>
    </>
  );
}
