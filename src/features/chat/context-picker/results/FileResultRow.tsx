import type { ContextEntity } from "@/types/electron";

import { friendlyFileType } from "../../components/entity-pill-kind";
import { FileExtensionIcon } from "../../components/entity-pill-visual";
import { ResultRowFrame } from "./ResultRowFrame";

interface FileResultRowProps {
  entity: Extract<ContextEntity, { type: "File" }>;
}

export function FileResultRow({ entity }: FileResultRowProps) {
  return (
    <>
      <FileExtensionIcon extension={entity.fileExtension} className="size-7 shrink-0" />
      <ResultRowFrame>
        <div className="truncate text-sm">{entity.title}</div>
        <div className="truncate text-xs text-muted-foreground">
          {friendlyFileType(entity.fileExtension)}
        </div>
      </ResultRowFrame>
    </>
  );
}
