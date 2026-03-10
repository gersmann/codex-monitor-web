import { describe, expect, it } from "vitest";
import { buildAppServerEnv } from "./codexSdk.js";

describe("buildAppServerEnv", () => {
  it("scrubs NODE_ENV and VITEST from the app-server child environment", () => {
    const env = buildAppServerEnv({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      NODE_ENV: "production",
      VITEST: "true",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
    });
  });

  it("preserves unrelated environment variables", () => {
    const env = buildAppServerEnv({
      PATH: "/usr/bin",
      CODEX_HOME: "/tmp/codex-home",
      SHELL: "/usr/bin/zsh",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      CODEX_HOME: "/tmp/codex-home",
      SHELL: "/usr/bin/zsh",
    });
  });
});
