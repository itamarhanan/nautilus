import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { useActions, useWorkspace } from "@/store";

export function SignOutConfirm() {
  const isOpen = useWorkspace((state) => state.isSignOutConfirmOpen);
  const { setSignOutConfirmOpen, signOut } = useActions();
  return (
    <AlertDialog
      isOpen={isOpen}
      onOpenChange={setSignOutConfirmOpen}
      title="Sign out of this device?"
      description="You will need a new pairing code from Nautilus on your PC to link this device again."
      actionLabel="Sign out"
      onAction={() => void signOut()}
    />
  );
}
