// Headings set in a caps-only font. pdftotext gives them in mixed case
// ("Ward of the Tester"); pdf.js can give them in random case and with wide gaps
// ("wArD  oF   the  teSter").
// The case is not a signal, so these helpers use the line's shape and normalise
// the name. Pure: shared by the CLI and the browser build.

/** Minor words stay lowercase in a title unless they lead it. */
export const MINOR_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

/** Case that only a caps-only font produces: a capital inside a word (not
 *  after a hyphen), or a word other than a minor word in lowercase. */
function irregularCase(t: string): boolean {
  return t
    .split(" ")
    .some((w) => /[a-z][A-Z]/.test(w) || (/^[a-z]/.test(w) && !MINOR_WORDS.has(w.toLowerCase())));
}

/**
 * The line as a heading candidate. pdf.js leaves wide gaps between the wide
 * glyphs of such a font, so a gap is collapsed when the case is irregular. Any
 * other gap marks a table row or a "Label  Value" line, and returns "".
 */
export function headingText(line: string): string {
  const t = line.trim();
  if (!/\s{2,}/.test(t)) return t;
  const collapsed = t.replace(/\s+/g, " ");
  return irregularCase(collapsed) ? collapsed : "";
}

/**
 * A short line of words only, in any case: no digits, no end punctuation.
 * Letters, spaces, apostrophes, hyphens, "&" and "/". Single letters other than
 * "a" mean letter-spaced text (a running header), not a heading.
 */
export function isHeadingShape(t: string, maxWords: number, maxLen: number): boolean {
  if (t.length < 3 || t.length > maxLen) return false;
  if (!/^[A-Za-z][A-Za-z ’'&/-]*[A-Za-z]$/.test(t)) return false;
  const words = t.split(" ").filter((w) => w !== "/");
  return words.length <= maxWords && words.every((w) => w.length > 1 || /^a$/i.test(w));
}

/** Title-case a heading: each word capitalised (and after a hyphen), minor
 *  words lowercase unless first. "sense" → "Sense", "TestWard" → "Testward". */
export function headingName(t: string): string {
  return t
    .toLowerCase()
    .split(" ")
    .map((w, i) =>
      i > 0 && MINOR_WORDS.has(w)
        ? w
        : w.replace(/(^|-)([a-z])/g, (_, pre, c) => pre + c.toUpperCase()),
    )
    .join(" ");
}
