import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { truncateObjective } from "./format";

interface ConfirmStopGoalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  objective: string;
  onConfirm: () => void;
}

export function ConfirmStopGoalDialog({
  open,
  onOpenChange,
  objective,
  onConfirm,
}: ConfirmStopGoalDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} data-testid="confirm-stop-goal-dialog">
        <DialogHeader>
          <DialogTitle>Stop this goal?</DialogTitle>
          <DialogDescription>
            &ldquo;{truncateObjective(objective, 80)}&rdquo; will no longer be pursued. Its current
            progress and context will remain visible.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => onConfirm()} data-testid="confirm-stop-goal">
            Stop Goal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
