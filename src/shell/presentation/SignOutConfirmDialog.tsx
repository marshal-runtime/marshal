import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface SignOutConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  /** Dialog title, filled by the composed identity so the dialog is
   *  backend-agnostic (e.g., "Sign out?" vs "Disconnect from Aether?"). */
  title?: string;
  description?: string;
  confirmLabel?: string;
}

const DEFAULT_TITLE = "Sign out?";
const DEFAULT_DESCRIPTION =
  "Signing out will also sign out of the GitHub Copilot CLI. You'll need to sign in again to continue.";
const DEFAULT_CONFIRM_LABEL = "Sign out";

export function SignOutConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title = DEFAULT_TITLE,
  description = DEFAULT_DESCRIPTION,
  confirmLabel = DEFAULT_CONFIRM_LABEL,
}: SignOutConfirmDialogProps) {
  const cancel = () => onOpenChange(false);
  const confirm = () => {
    onOpenChange(false);
    onConfirm();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={cancel}>
            Cancel
          </Button>
          <Button onClick={confirm}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
