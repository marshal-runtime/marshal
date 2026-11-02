import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface DeleteSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionName: string;
  onConfirm: () => void;
}

export function DeleteSessionDialog({
  open,
  onOpenChange,
  sessionName,
  onConfirm,
}: DeleteSessionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="border-destructive">
        <DialogHeader className="gap-3">
          <div className="flex size-10 items-center justify-center rounded-full bg-destructive text-white">
            <span aria-hidden="true" className="text-lg font-bold">
              !
            </span>
          </div>
          <DialogTitle>Delete session?</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">&ldquo;{sessionName}&rdquo;</span> will be
            permanently deleted. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="border-t border-border pt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
