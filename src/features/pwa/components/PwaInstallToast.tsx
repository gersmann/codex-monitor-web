import {
  ToastActions,
  ToastBody,
  ToastCard,
  ToastHeader,
  ToastTitle,
  ToastViewport,
} from "@/features/design-system/components/toast/ToastPrimitives";

type PwaInstallToastProps = {
  showInstallPrompt: boolean;
  updateAvailable: boolean;
  onInstall: () => void;
  onDismissInstall: () => void;
  onApplyUpdate: () => void;
  onDismissUpdate: () => void;
};

export function PwaInstallToast({
  showInstallPrompt,
  updateAvailable,
  onInstall,
  onDismissInstall,
  onApplyUpdate,
  onDismissUpdate,
}: PwaInstallToastProps) {
  if (!showInstallPrompt && !updateAvailable) {
    return null;
  }

  return (
    <ToastViewport className="pwa-toasts" role="region" ariaLive="polite">
      <ToastCard className="pwa-toast" role="status">
        <ToastHeader className="pwa-toast-header">
          <ToastTitle className="pwa-toast-title">
            {updateAvailable ? "App Update" : "Install App"}
          </ToastTitle>
        </ToastHeader>
        <ToastBody className="pwa-toast-body">
          {updateAvailable
            ? "A newer web app version is ready. Reload to update the installed shell."
            : "Install Codex Monitor Web for a standalone app experience on this device."}
        </ToastBody>
        <ToastActions className="pwa-toast-actions">
          <button
            className="secondary"
            onClick={updateAvailable ? onDismissUpdate : onDismissInstall}
          >
            {updateAvailable ? "Later" : "Dismiss"}
          </button>
          <button
            className="primary"
            onClick={updateAvailable ? onApplyUpdate : onInstall}
          >
            {updateAvailable ? "Reload" : "Install"}
          </button>
        </ToastActions>
      </ToastCard>
    </ToastViewport>
  );
}
