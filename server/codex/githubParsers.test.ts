import { describe, expect, it } from "vitest";
import {
  gitHubRepoNamesMatch,
  githubRepoExistsMessage,
  normalizeRepoFullName,
  parseGitHubPullRequestDiff,
  parseGitHubRepo,
  validateGitHubRepoName,
  validateNormalizedRepoName,
} from "./githubParsers.js";

describe("githubParsers", () => {
  it("normalizes and validates GitHub repository names", () => {
    expect(parseGitHubRepo("https://github.com/openai/codex.git")).toBe("openai/codex");
    expect(parseGitHubRepo("git@github.com:openai/codex.git")).toBe("openai/codex");
    expect(normalizeRepoFullName("https://github.com/openai/codex.git")).toBe("openai/codex");
    expect(gitHubRepoNamesMatch("OpenAI/Codex", "openai/codex")).toBe(true);
    expect(validateGitHubRepoName("openai/codex")).toBe("openai/codex");
    expect(validateNormalizedRepoName("https://github.com/openai/codex")).toBe("openai/codex");
    expect(() => validateGitHubRepoName("bad repo")).toThrow("spaces");
  });

  it("detects GitHub repo-exists error messages", () => {
    expect(githubRepoExistsMessage("name already exists on this account")).toBe(true);
    expect(githubRepoExistsMessage("permission denied")).toBe(false);
  });

  it("parses GitHub pull request diffs", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/a.ts",
      "@@ -0,0 +1 @@",
      "+const a = 1;",
      "diff --git a/old.ts b/new.ts",
      "rename from old.ts",
      "rename to new.ts",
    ].join("\n");
    expect(parseGitHubPullRequestDiff(diff)).toEqual([
      expect.objectContaining({ path: "a.ts", status: "A" }),
      expect.objectContaining({ path: "new.ts", status: "R" }),
    ]);
  });
});
