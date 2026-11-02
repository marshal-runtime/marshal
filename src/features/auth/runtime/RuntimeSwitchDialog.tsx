import {
  canSwitchRuntimeLive,
  getRuntimeDisplayName,
  getRuntimeSelectionMetadata,
} from "@common/runtime-config";
import { useState } from "react";

import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRuntimeStartupSelection } from "@/features/settings/useSettings";

interface RuntimeSwitchDialogProps {
  currentRuntimeId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function RuntimeSwitchDialog({
  currentRuntimeId,
  open,
  onOpenChange,
}: RuntimeSwitchDialogProps) {
  const { switchRuntime, isSwitching, switchError } = useRuntimeStartupSelection();
  const options = getRuntimeSelectionMetadata(currentRuntimeId).filter(
    (runtime) => runtime.selectable && runtime.id !== currentRuntimeId,
  );
  const [targetRuntimeId, setTargetRuntimeId] = useState(() => options[0]?.id ?? currentRuntimeId);
  const [savedRuntimeId, setSavedRuntimeId] = useState<string | null>(null);
  const switchesLive = canSwitchRuntimeLive(currentRuntimeId, targetRuntimeId);
  const errorMessage = switchError?.message ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{savedRuntimeId ? "Runtime change saved" : "Change AI runtime"}</DialogTitle>
          <DialogDescription>
            {savedRuntimeId
              ? `Marshal will use ${getRuntimeDisplayName(savedRuntimeId)} after you restart.`
              : switchesLive
                ? "Choose a runtime to activate immediately. Existing chats transfer context only when you continue them in the selected runtime."
                : "Choose a runtime for the next app launch."}
          </DialogDescription>
        </DialogHeader>
        {!savedRuntimeId && (
          <Select value={targetRuntimeId} onValueChange={setTargetRuntimeId} disabled={isSwitching}>
            <SelectTrigger aria-label="Recovery runtime">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((runtime) => (
                <SelectItem key={runtime.id} value={runtime.id}>
                  {runtime.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {errorMessage && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        )}
        <DialogFooter>
          {savedRuntimeId ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button onClick={() => void window.shellAPI?.quitApp()}>Quit Marshal</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                disabled={isSwitching || targetRuntimeId === currentRuntimeId}
                onClick={() => {
                  void switchRuntime(targetRuntimeId)
                    .then((result) => {
                      if (result.requiresRestart) {
                        setSavedRuntimeId(targetRuntimeId);
                      } else {
                        onOpenChange(false);
                      }
                    })
                    .catch(() => {});
                }}
              >
                {isSwitching ? "Switching…" : switchesLive ? "Switch now" : "Use after restart"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
