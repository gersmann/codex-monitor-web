import { describe, expect, it } from "vitest";
import { isMobilePlatform } from "./platformPaths";

function withNavigatorValues(
  values: Partial<Pick<Navigator, "platform" | "userAgent">>,
  run: () => void,
) {
  const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
  const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: values.platform ?? navigator.platform,
  });
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: values.userAgent ?? navigator.userAgent,
  });
  try {
    run();
  } finally {
    if (originalPlatform) {
      Object.defineProperty(navigator, "platform", originalPlatform);
    }
    if (originalUserAgent) {
      Object.defineProperty(navigator, "userAgent", originalUserAgent);
    }
  }
}

describe("isMobilePlatform", () => {
  it("returns true for iPhone-like user agents", () => {
    withNavigatorValues(
      {
        platform: "iPhone",
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
      },
      () => {
        expect(isMobilePlatform()).toBe(true);
      },
    );
  });

  it("returns false for desktop platforms", () => {
    withNavigatorValues(
      {
        platform: "MacIntel",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_0) AppleWebKit/537.36",
      },
      () => {
        expect(isMobilePlatform()).toBe(false);
      },
    );
  });
});
