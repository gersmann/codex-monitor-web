import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./promptFrontmatter.js";

describe("promptFrontmatter", () => {
  it("parses prompt frontmatter metadata", () => {
    expect(
      parseFrontmatter("---\ndescription: \"Hello\"\nargument-hint: 'Arg'\n---\nBody text\n"),
    ).toEqual({
      description: "Hello",
      argumentHint: "Arg",
      body: "Body text\n",
    });
    expect(parseFrontmatter("No frontmatter")).toEqual({
      description: null,
      argumentHint: null,
      body: "No frontmatter",
    });
  });
});
