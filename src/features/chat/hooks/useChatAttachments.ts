import { createLogger } from "@common/marshal-logger";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import type { FileAttachment } from "../components/ChatInput";

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

const log = createLogger("useChatAttachments");

export interface UseChatAttachmentsReturn {
  isUploading: boolean;
  pendingFiles: FileAttachment[];
  contextFiles: string[];
  contextFileAttachments: FileAttachment[];
  imageSizeWarning: string | null;
  addFileFromFile: (file: File) => void;
  addAttachments: (files: FileAttachment[]) => void;
  removeFile: (index: number) => void;
  removeContextFile: (index: number) => void;
  addContextFile: (filePath: string) => void;
  clearContextFiles: () => void;
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handlePaste: (e: React.ClipboardEvent) => void;
  clear: () => void;
}

export function useChatAttachments(initialFiles: FileAttachment[] = []): UseChatAttachmentsReturn {
  const [uploads, setUploads] = useState(0);
  const [pendingFiles, setPendingFiles] = useState<FileAttachment[]>(initialFiles);
  const [contextFiles, setContextFiles] = useState<string[]>([]);

  const addFileFromFile = useCallback((file: File) => {
    if (window.marshalRemote && file.size > 10 * 1024 * 1024) {
      toast.error("Choose a file smaller than 10 MB.");
      return;
    }
    if (window.marshalRemote && !file.type.startsWith("image/")) {
      setUploads((n) => n + 1);
      const reader = new FileReader();
      reader.onload = () => {
        void (async () => {
          const notification = toast.loading(`Uploading ${file.name}…`);
          try {
            if (typeof reader.result !== "string") throw new Error("Unable to read file");
            const data = reader.result.split(",")[1];
            const response = await fetch("/remote/upload", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: file.name, data }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error ?? "Upload failed");
            setPendingFiles((prev) => [
              ...prev,
              {
                path: result.path,
                mimeType: file.type || "application/octet-stream",
                name: file.name,
              },
            ]);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Upload failed");
          } finally {
            setUploads((n) => n - 1);
            toast.dismiss(notification);
          }
        })();
      };
      reader.onerror = () => {
        setUploads((n) => n - 1);
        toast.error("Could not read this file.");
      };
      reader.readAsDataURL(file);
      return;
    }
    if (file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = () => {
        setPendingFiles((prev) => [
          ...prev,
          {
            dataUrl: typeof reader.result === "string" ? reader.result : "",
            mimeType: file.type,
            name: file.name,
            largeFile: file.size > MAX_IMAGE_SIZE,
          },
        ]);
      };
      reader.readAsDataURL(file);
      return;
    }

    const path = window.workspaceAPI?.getPathForFile(file) ?? "";
    if (!path) {
      log.warn(
        `getPathForFile returned empty path for "${file.name}" — attachment will have no content.`,
      );
    }
    setPendingFiles((prev) => [
      ...prev,
      {
        path,
        mimeType: file.type || "application/octet-stream",
        name: file.name,
      },
    ]);
  }, []);

  const addAttachments = useCallback((files: FileAttachment[]) => {
    if (files.length === 0) return;
    setPendingFiles((prev) => [...prev, ...files]);
  }, []);

  const removeFile = useCallback((index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const removeContextFile = useCallback((index: number) => {
    setContextFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addContextFile = useCallback((filePath: string) => {
    setContextFiles((prev) => (prev.includes(filePath) ? prev : [...prev, filePath]));
  }, []);

  const clearContextFiles = useCallback(() => {
    setContextFiles([]);
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;
      for (const file of files) {
        addFileFromFile(file);
      }
      e.target.value = "";
    },
    [addFileFromFile],
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) addFileFromFile(file);
          return;
        }
      }
    },
    [addFileFromFile],
  );

  const imageSizeWarning = useMemo(() => {
    const largeFiles = pendingFiles.filter((file) => file.largeFile);
    if (largeFiles.length === 0) return null;
    if (largeFiles.length === 1) {
      return `"${largeFiles[0].name}" is large and may slow down the chat.`;
    }
    return `${largeFiles.length} attached images are large and may slow down the chat.`;
  }, [pendingFiles]);

  const contextFileAttachments: FileAttachment[] = useMemo(
    () =>
      contextFiles.map((filePath) => ({
        path: filePath,
        mimeType: "application/octet-stream",
        name: filePath.split(/[\\/]/).pop() || filePath,
      })),
    [contextFiles],
  );

  const clear = useCallback(() => {
    setPendingFiles([]);
    setContextFiles([]);
  }, []);

  return {
    isUploading: uploads > 0,
    pendingFiles,
    contextFiles,
    contextFileAttachments,
    imageSizeWarning,
    addFileFromFile,
    addAttachments,
    removeFile,
    removeContextFile,
    addContextFile,
    clearContextFiles,
    handleFileSelect,
    handlePaste,
    clear,
  };
}
