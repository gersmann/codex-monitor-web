import { afterEach, describe, expect, it, vi } from "vitest";

describe("convertLocalFileSrc", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unmock("./runtime");
    vi.unmock("@tauri-apps/api/core");
  });

  it("returns an empty string in the web runtime for local paths", async () => {
    vi.doMock("./runtime", () => ({
      isWebCompanionRuntime: () => true,
    }));
    vi.doMock("@tauri-apps/api/core", () => ({
      convertFileSrc: vi.fn((path: string) => `tauri://${path}`),
    }));

    const { convertLocalFileSrc } = await import("./fileSrc");

    expect(convertLocalFileSrc("/tmp/icon.png")).toBe("");
  });

  it("uses the Tauri file converter outside the web runtime", async () => {
    const convertFileSrc = vi.fn((path: string) => `tauri://${path}`);
    vi.doMock("./runtime", () => ({
      isWebCompanionRuntime: () => false,
    }));
    vi.doMock("@tauri-apps/api/core", () => ({
      convertFileSrc,
    }));

    const { convertLocalFileSrc } = await import("./fileSrc");

    expect(convertLocalFileSrc("/tmp/icon.png")).toBe("tauri:///tmp/icon.png");
    expect(convertFileSrc).toHaveBeenCalledWith("/tmp/icon.png");
  });

  it("passes through remote and embedded image sources", async () => {
    const { convertLocalFileSrc } = await import("./fileSrc");

    expect(convertLocalFileSrc("data:image/png;base64,abc")).toBe(
      "data:image/png;base64,abc",
    );
    expect(convertLocalFileSrc("https://example.com/icon.png")).toBe(
      "https://example.com/icon.png",
    );
  });
});
