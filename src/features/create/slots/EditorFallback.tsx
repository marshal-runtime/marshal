import { CreateModeIcon } from "../components/CreateModeIcon";
import { FilePreview } from "../FilePreview";
import { ZOOM_EPSILON } from "../hooks/state/useZoom";

interface EditorFallbackProps {
  selectedFile: string | null;
  onError: () => void;
  zoom: number;
  zoomHydrated: boolean;
}

export function EditorFallback({ selectedFile, onError, zoom, zoomHydrated }: EditorFallbackProps) {
  if (!zoomHydrated) {
    return null;
  }

  if (selectedFile) {
    return <FilePreview filePath={selectedFile} onError={onError} zoom={zoom} />;
  }
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
      style={Math.abs(zoom - 1) > ZOOM_EPSILON ? { zoom } : undefined}
    >
      <div className="mb-2 opacity-90">
        <CreateModeIcon size={48} />
      </div>
      <h2 className="m-0 text-xl font-semibold text-foreground">Workspaces</h2>
      <p className="m-0 max-w-[280px] text-sm/relaxed text-foreground-secondary">
        Craft documents, presentations, and more with AI assistance.
      </p>
      <div className="mt-5 mb-2 flex flex-col gap-3 text-left">
        <div className="flex items-center gap-3 text-[13px] text-foreground-secondary">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground">
            1
          </span>
          <span>Tell the AI what you want to create</span>
        </div>
        <div className="flex items-center gap-3 text-[13px] text-foreground-secondary">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground">
            2
          </span>
          <span>Review and refine the outline together</span>
        </div>
        <div className="flex items-center gap-3 text-[13px] text-foreground-secondary">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground">
            3
          </span>
          <span>Export to PPTX, DOCX, or copy the markdown</span>
        </div>
      </div>
      <p className="m-0 mt-4 text-xs text-muted-foreground italic">
        Start a conversation in the chat panel →
      </p>
    </div>
  );
}
