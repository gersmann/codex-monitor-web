import { describe, expect, it } from "vitest";
import { parseGitLogEntries, parseNumstat, parseStatusEntries } from "./gitParsers.js";

describe("gitParsers", () => {
  it("parses git numstat output", () => {
    const stats = parseNumstat("3\t1\tsrc/a.ts\n0\t4\tsrc\\b.ts\n");
    expect(stats.get("src/a.ts")).toEqual({ additions: 3, deletions: 1 });
    expect(stats.get("src/b.ts")).toEqual({ additions: 0, deletions: 4 });
  });

  it("parses porcelain status output including rename records", () => {
    const output = `## main...origin/main\0R  old.ts\0new.ts\0?? untracked.ts\0`;
    expect(parseStatusEntries(output)).toEqual([
      {
        path: "new.ts",
        indexStatus: "R",
        worktreeStatus: null,
        untracked: false,
      },
      {
        path: "untracked.ts",
        indexStatus: null,
        worktreeStatus: null,
        untracked: true,
      },
    ]);
  });

  it("parses git log entries and converts timestamps to milliseconds", () => {
    expect(parseGitLogEntries("sha\x1fsummary\x1fauthor\x1f12\x1e")).toEqual([
      {
        sha: "sha",
        summary: "summary",
        author: "author",
        timestamp: 12_000,
      },
    ]);
  });
});
