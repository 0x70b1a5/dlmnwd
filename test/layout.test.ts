import { expect, test } from "bun:test";
import { type GlyphRun, layoutBlocks, layoutRuns } from "../src/pdf/layout.ts";

// layout.ts ports the text layout of `pdftotext -layout` (poppler 24.02). Each
// expected string below is what pdftotext prints for the same glyphs drawn in
// Courier (0.6 em advance, ascent 0.629, descent -0.157) at the same places.

/** One run per glyph, as pdf.js gives them. `pitch` is the distance between glyphs. */
function word(s: string, x: number, base: number, fs = 10, pitch = 0.6 * fs): GlyphRun[] {
  return [...s].map((c, i) => ({
    str: c,
    x: x + i * pitch,
    base,
    width: 0.6 * fs,
    fontSize: fs,
    font: "F1",
    ascent: 0.629,
    descent: -0.157,
  }));
}

test("joins glyphs with a small gap into one word", () => {
  expect(layoutRuns([...word("ab", 0, 100), ...word("cd", 12.5, 100)])).toBe("abcd\n");
});

test("breaks a word at a gap wider than a tenth of the font size", () => {
  expect(layoutRuns([...word("ab", 0, 100), ...word("cd", 14, 100)])).toBe("ab cd\n");
});

test("puts lines one baseline apart on consecutive rows", () => {
  expect(layoutRuns([...word("one", 0, 100), ...word("two", 0, 112)])).toBe("one\ntwo\n");
});

test("adds blank lines for a wide baseline gap", () => {
  expect(layoutRuns([...word("one", 0, 100), ...word("two", 0, 130)])).toBe("one\n\n\ntwo\n");
});

test("caps the blank lines at five", () => {
  const out = layoutRuns([...word("one", 0, 100), ...word("two", 0, 400)]);
  expect(out).toBe("one\n\n\n\n\ntwo\n");
});

test("starts a block to the right three columns after the text to its left", () => {
  // The x position does not set the column: only the characters to the left do.
  expect(layoutRuns([...word("alpha", 0, 100), ...word("beta", 300, 100)])).toBe("alpha   beta\n");
  expect(layoutRuns([...word("left", 0, 100), ...word("right", 60, 100)])).toBe("left   right\n");
});

test("aligns a right-hand block on every row", () => {
  const out = layoutRuns([
    ...word("1", 0, 100),
    ...word("Boots", 100, 100),
    ...word("22", 0, 112),
    ...word("Cane", 100, 112),
  ]);
  expect(out).toBe("1    Boots\n22   Cane\n");
});

test("places a lower block by the widest block above it", () => {
  const out = layoutRuns([...word("a long first line", 0, 100), ...word("tail", 120, 160)]);
  expect(out).toBe(`a long first line\n\n\n\n\n${" ".repeat(20)}tail\n`);
});

test("drops a word drawn twice at the same place", () => {
  expect(layoutRuns([...word("tag", 0, 100), ...word("tag", 0, 100)])).toBe("tag\n");
});

test("joins slightly letter-spaced glyphs into one word", () => {
  expect(layoutRuns(word("WARD", 0, 100, 10, 7.5))).toBe("WARD\n");
  expect(layoutRuns(word("WARD", 0, 100, 10, 8.5))).toBe("WARD\n");
});

test("keeps widely letter-spaced glyphs apart", () => {
  expect(layoutRuns(word("WARD", 0, 100, 10, 12))).toBe("W A R D\n");
});

test("puts a smaller font on its own line", () => {
  const out = layoutRuns([...word("Big", 0, 100, 20), ...word("small body", 0, 115, 10)]);
  expect(out).toBe("Big\nsmall body\n");
});

test("breaks a word at a single space glyph and keeps a longer run whole", () => {
  expect(layoutRuns(word("a b", 0, 100))).toBe("a b\n");
  // An /ActualText span arrives as one run; its spaces stay inside the word.
  const span: GlyphRun = { ...word("x", 0, 100)[0], str: "a b", width: 18 };
  expect(layoutRuns([span])).toBe("a b\n");
});

test("returns the blocks with their bounds", () => {
  const blocks = layoutBlocks([...word("alpha", 0, 100), ...word("beta", 300, 100)]);
  expect(blocks.map((b) => b.lines)).toEqual([["alpha"], ["beta"]]);
  expect(blocks[1].x).toEqual([300, 300 + 4 * 6]);
});
