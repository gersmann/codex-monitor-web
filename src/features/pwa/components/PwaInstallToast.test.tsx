import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PwaInstallToast } from "./PwaInstallToast";

describe("PwaInstallToast", () => {
  it("renders nothing when neither install nor update is available", () => {
    const html = renderToStaticMarkup(
      <PwaInstallToast
        showInstallPrompt={false}
        updateAvailable={false}
        onInstall={vi.fn()}
        onDismissInstall={vi.fn()}
        onApplyUpdate={vi.fn()}
        onDismissUpdate={vi.fn()}
      />,
    );

    expect(html).toBe("");
  });

  it("renders install copy when installation is available", () => {
    const html = renderToStaticMarkup(
      <PwaInstallToast
        showInstallPrompt
        updateAvailable={false}
        onInstall={vi.fn()}
        onDismissInstall={vi.fn()}
        onApplyUpdate={vi.fn()}
        onDismissUpdate={vi.fn()}
      />,
    );

    expect(html).toContain("Install App");
    expect(html).toContain("Install Codex Monitor Web");
  });

  it("renders update copy when a service worker update is waiting", () => {
    const html = renderToStaticMarkup(
      <PwaInstallToast
        showInstallPrompt={false}
        updateAvailable
        onInstall={vi.fn()}
        onDismissInstall={vi.fn()}
        onApplyUpdate={vi.fn()}
        onDismissUpdate={vi.fn()}
      />,
    );

    expect(html).toContain("App Update");
    expect(html).toContain("Reload to update");
  });
});
