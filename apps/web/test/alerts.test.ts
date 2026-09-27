import { beforeEach, describe, expect, it, vi } from "vitest";

function stubBrowser(visibility: "hidden" | "visible") {
  const page = { visibilityState: visibility, title: "Nautilus" };
  const setAppBadge = vi.fn(() => Promise.resolve());
  const clearAppBadge = vi.fn(() => Promise.resolve());
  const showNotification = vi.fn(() => Promise.resolve());
  vi.stubGlobal("document", page);
  vi.stubGlobal("navigator", {
    setAppBadge,
    clearAppBadge,
    serviceWorker: { ready: Promise.resolve({ showNotification }) },
  });
  vi.stubGlobal("Notification", { permission: "granted" });
  return { page, setAppBadge, clearAppBadge, showNotification };
}

const alert = {
  title: "The agent finished",
  body: "Shop",
  tag: "s1",
  url: "/?project=shop",
};

describe("alerts", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("counts unseen alerts in the badge and title, and notifies, while hidden", async () => {
    const browser = stubBrowser("hidden");
    const { clearAlerts, showAlert } = await import("@/lib/alerts");
    showAlert(alert);
    showAlert({ ...alert, title: "The agent needs your approval" });
    expect(browser.page.title).toBe("(2) Nautilus");
    expect(browser.setAppBadge).toHaveBeenLastCalledWith(2);
    await vi.waitFor(() => {
      expect(browser.showNotification).toHaveBeenCalledWith("The agent finished", {
        body: "Shop",
        tag: "s1",
        data: { url: "/?project=shop" },
      });
    });

    clearAlerts();
    expect(browser.page.title).toBe("Nautilus");
    expect(browser.clearAppBadge).toHaveBeenCalled();
  });

  it("stays quiet while the app is on screen", async () => {
    const browser = stubBrowser("visible");
    const { showAlert } = await import("@/lib/alerts");
    showAlert(alert);
    expect(browser.page.title).toBe("Nautilus");
    expect(browser.setAppBadge).not.toHaveBeenCalled();
    expect(browser.showNotification).not.toHaveBeenCalled();
  });
});
