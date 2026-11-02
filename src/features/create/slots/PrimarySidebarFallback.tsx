import { ArrowLeft } from "@/components/icons";

import { FileTree } from "../FileTree";
import { WorkspaceSwitcher } from "../WorkspaceSwitcher";

interface PrimarySidebarFallbackProps {
  onBack?: () => void;
  activeWorkspace: string;
  onSwitch: (name: string) => void;
  selectedFile?: string;
  onFileSelect: (filePath: string | null) => void;
}

export function PrimarySidebarFallback({
  onBack,
  activeWorkspace,
  onSwitch,
  selectedFile,
  onFileSelect,
}: PrimarySidebarFallbackProps) {
  return (
    <>
      {onBack && (
        <button
          className="flex shrink-0 items-center gap-1.5 border-b border-border bg-transparent px-3 py-2 text-[13px] text-foreground-secondary [app-region:no-drag] hover:bg-muted hover:text-foreground"
          onClick={onBack}
          title="Back"
        >
          <ArrowLeft size={18} />
          <span>Back</span>
        </button>
      )}
      <WorkspaceSwitcher activeWorkspace={activeWorkspace} onSwitch={onSwitch} />
      <FileTree
        onFileSelect={onFileSelect}
        selectedFile={selectedFile}
        workspaceName={activeWorkspace}
      />
    </>
  );
}
