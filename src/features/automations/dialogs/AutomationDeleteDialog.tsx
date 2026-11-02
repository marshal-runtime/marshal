import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface AutomationDeleteDialogProps {
  deleteConfirm: {
    id: string;
    name: string;
    skillNames: string[];
  };
  onDelete: (id: string, deleteSkills: boolean) => void;
  onCancel: () => void;
}

export function AutomationDeleteDialog({
  deleteConfirm,
  onDelete,
  onCancel,
}: AutomationDeleteDialogProps) {
  const skillCount = deleteConfirm.skillNames.length;

  return (
    <Dialog open onOpenChange={(open: boolean) => !open && onCancel()}>
      <DialogContent showCloseButton={false} className="overflow-hidden p-0">
        <div className="border-b border-border/60 bg-destructive/5 px-6 py-5">
          <DialogHeader>
            <DialogTitle>Delete &ldquo;{deleteConfirm.name}&rdquo;?</DialogTitle>
            <DialogDescription>
              This automation has {skillCount} associated skill{skillCount === 1 ? "" : "s"}:
            </DialogDescription>
          </DialogHeader>
        </div>
        <div className="px-6 py-4">
          <ul className="space-y-1 rounded-lg border border-border/50 bg-muted/20 px-4 py-3 text-xs text-primary">
            {deleteConfirm.skillNames.map((name) => (
              <li key={name} className="list-inside list-disc">
                /{name}
              </li>
            ))}
          </ul>
        </div>
        <DialogFooter className="border-t border-border/60 bg-muted/10 px-6 py-4 sm:flex-col sm:gap-1.5">
          <Button
            variant="destructive"
            className="w-full"
            onClick={() => onDelete(deleteConfirm.id, true)}
          >
            Delete automation + skills
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => onDelete(deleteConfirm.id, false)}
          >
            Delete automation only
          </Button>
          <DialogClose asChild>
            <Button variant="ghost" className="w-full">
              Cancel
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
