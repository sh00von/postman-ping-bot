import { describe, it, expect } from "vitest";
import { cleanSnippet } from "../lib/telegram.js";

describe("cleanSnippet", () => {
  it("returns short snippets unchanged", () => {
    expect(cleanSnippet("Hello world")).toBe("Hello world");
  });

  it("returns empty string for empty or whitespace-only input", () => {
    expect(cleanSnippet("")).toBe("");
    expect(cleanSnippet("   \n\t  ")).toBe("");
    expect(cleanSnippet()).toBe("");
  });

  it("collapses newlines and repeated whitespace into single spaces", () => {
    expect(cleanSnippet("Dear author,\n\n  Thank you\r\n for your\nsubmission.")).toBe(
      "Dear author, Thank you for your submission."
    );
  });

  it("trims leading and trailing whitespace", () => {
    expect(cleanSnippet("  padded snippet  ")).toBe("padded snippet");
  });

  it("truncates long snippets at a word boundary with an ellipsis", () => {
    const long =
      "This is a fairly long preview sentence that keeps going well past the limit we set for one alert line";
    const out = cleanSnippet(long, 60);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(61);
    // Word-boundary cut: the prefix is a prefix of the original and the next
    // original character after it is a space, so no word is split in half.
    const prefix = out.slice(0, -1);
    expect(long.startsWith(prefix)).toBe(true);
    expect(long[prefix.length]).toBe(" ");
  });

  it("does not truncate a snippet exactly at the limit", () => {
    const exact = "x".repeat(20);
    expect(cleanSnippet(exact, 20)).toBe(exact);
  });

  it("falls back to a hard cut when there is no word boundary in range", () => {
    const oneWord = "a".repeat(100);
    expect(cleanSnippet(oneWord, 40)).toBe(`${"a".repeat(40)}…`);
  });
});
