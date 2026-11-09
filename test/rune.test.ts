import { expect, test } from "bun:test";
import { parseFrequency, parseRunes } from "../src/parse/rune.ts";

// Invented rune tables: magnitudes are discovered from the "<X> RUNES" headings,
// so these use made-up ones.
const page = [
  "                                 RUNE GRANTED",
  "                        2d6         Rune Granted",
  "                      3 or less     Cold silence—no rune",
  "                         4–8        1 faint rune (randomly selected)",
  "                         9–11       1 bright rune (randomly selected)",
  "                      12 or more    1 blazing rune (randomly selected)",
  "",
  "Learning: roll on the Rune Granted table. Characters of Level 2–4 gain a",
  "+1 bonus to the roll, and characters of Level 5 or above gain a +2 bonus.",
  "",
  "          RUNE USAGE FREQUENCY",
  "                        Caster’s Current Level",
  "Type             1–3              4–8                  9+",
  "Faint        Once per day     Twice per day    Thrice per day",
  "Bright      Once per Level    Once per week     Once per day",
  "Blazing       Once ever        Once ever       Once per year",
  "",
  "        FAINT RUNES                                   BRIGHT RUNES                                BLAZING RUNES",
  "  #   Rune                                      #      Rune                                     #   Rune",
  "  1   Mote of Dew                                 1    Lantern Bridge                           1   Starfall",
  "  2   Whisper Knot                                2    Hollow Stair                             2   Unmaking",
  "",
].join("\n");

test("discovers rune lists by magnitude heading", () => {
  const r = parseRunes([page]);
  expect(r.runes).toEqual([
    { name: "Mote of Dew", magnitude: "faint" },
    { name: "Lantern Bridge", magnitude: "bright" },
    { name: "Starfall", magnitude: "blazing" },
    { name: "Whisper Knot", magnitude: "faint" },
    { name: "Hollow Stair", magnitude: "bright" },
    { name: "Unmaking", magnitude: "blazing" },
  ]);
});

test("parses usage frequency by magnitude and level band", () => {
  const r = parseRunes([page]);
  expect(r.usage.faint[1]).toEqual({
    minLevel: 4,
    maxLevel: 8,
    text: "Twice per day",
    freq: { count: 2, period: "day" },
  });
  expect(r.usage.bright[0].freq).toEqual({ count: 1, period: "level" });
  expect(r.usage.blazing[0].freq).toEqual({ count: 1, period: "ever" });
  expect(r.usage.blazing[2]).toMatchObject({ minLevel: 9, maxLevel: null });
});

test("parses the grant table and its level bonus", () => {
  const r = parseRunes([page]);
  expect(r.granted.map((g) => [g.min, g.max, g.magnitude])).toEqual([
    [null, 3, null],
    [4, 8, "faint"],
    [9, 11, "bright"],
    [12, null, "blazing"],
  ]);
  expect(r.levelBonus).toEqual([
    { minLevel: 2, maxLevel: 4, bonus: 1 },
    { minLevel: 5, maxLevel: null, bonus: 2 },
  ]);
});

test("reads frequency phrases", () => {
  expect(parseFrequency("Thrice per day")).toEqual({ count: 3, period: "day" });
  expect(parseFrequency("Once per week")).toEqual({ count: 1, period: "week" });
  expect(parseFrequency("4 times per year")).toEqual({ count: 4, period: "year" });
  expect(parseFrequency("Whenever")).toBeNull();
});

// Invented rune entries, two columns like the book: heading, Duration, Range,
// then prose. One name wraps onto two lines; one prose block starts "Duration:".
const col = (left: string, right = ""): string => left.padEnd(60) + right;
const entries = [
  col("Mote of Dew", "Lantern"),
  col("Duration: 3 Rounds or until sipped"),
  col("Range: Self"),
  col("", "Bridge"),
  col("A bead of dew gathers on the caster’s palm.", "Duration: 1 hour"),
  col("Drinking: One who drinks it is refreshed.", "Range: 60′"),
  col("Duration: The bead dries away when", "A bridge of lamplight spans a gap."),
  col("the sun next rises.", "Weight: It bears one creature at a time."),
  "",
  col("Whisper Knot"),
  col("Duration: 1 day"),
  col("Range: Touch"),
  col("A knot that repeats one whispered word."),
].join("\n");

test("reads each rune's own entry", () => {
  const r = parseRunes([page, entries]);
  const by = (n: string) => r.runes.find((x) => x.name === n);
  expect(by("Mote of Dew")).toEqual({
    name: "Mote of Dew",
    magnitude: "faint",
    duration: "3 Rounds or until sipped",
    range: "Self",
    body:
      "A bead of dew gathers on the caster’s palm.\n" +
      "Drinking: One who drinks it is refreshed.\n" +
      "Duration: The bead dries away when the sun next rises.",
  });
  // The wrapped heading is one name, and it ends the entry above it.
  expect(by("Lantern Bridge")).toMatchObject({
    duration: "1 hour",
    range: "60′",
    body: "A bridge of lamplight spans a gap.\nWeight: It bears one creature at a time.",
  });
  expect(by("Whisper Knot")).toMatchObject({
    duration: "1 day",
    range: "Touch",
    body: "A knot that repeats one whispered word.",
  });
  // A rune with no entry keeps only its name and magnitude.
  expect(by("Starfall")).toEqual({ name: "Starfall", magnitude: "blazing" });
});
