import { expect, test } from "bun:test";
import { headingName, headingText, isHeadingShape } from "../src/parse/heading.ts";
import { extractTraits } from "../src/parse/traits.ts";

// Invented, non-canon sections whose headings are set in a caps-only font but
// stored in mixed case (pdftotext) or random case with wide gaps (pdf.js).

test("normalises heading text from either renderer", () => {
  expect(headingName("sense")).toBe("Sense");
  expect(headingName("TestWard")).toBe("Testward");
  expect(headingName("anti-test WARD of the deep")).toBe("Anti-Test Ward of the Deep");
  // A gap is collapsed only in irregular case; a "Label  Value" line is rejected.
  expect(headingText("glyPh oF        Testing")).toBe("glyPh oF Testing");
  expect(headingText("Prime Abilities   Wisdom")).toBe("");
  expect(isHeadingShape("P a R T", 4, 34)).toBe(false); // letter-spaced header
  expect(isHeadingShape("Stone Sense", 4, 34)).toBe(true);
  expect(isHeadingShape("Stone sense.", 4, 34)).toBe(false);
});

const kindredSpan = [
  "Testfolk",
  "Kindred Type     Mortal",
  "Testfolk live in invented burrows.",
  "",
  "Burrow Lore", // lore heading before "Choosing": not a trait
  "Their burrows are made up for this test.",
  "",
  "Choosing a Class",
  "Testfolk are often testers.",
  "",
  "Stone Sense",
  "A testfolk always knows which way is down.",
  "",
  "tunnel   viSion", // pdf.js rendering of the same kind of heading
  "They see in total darkness.",
  "",
  "TESTFOLK NAMES", // a caps table title: not a trait, and ends the run
  "Bod Hill",
  "",
  "Hardy",
  "Testfolk shrug off invented poisons. The",
  "Taste Test", // mid-sentence capitalised line: not a heading
  "never fails them.",
].join("\n");

test("reads mixed-case trait headings after the Choosing section", () => {
  const traits = extractTraits([kindredSpan], 0, 1, "Testfolk");
  expect(traits.map((t) => t.name)).toEqual(["Stone Sense", "Tunnel Vision", "Hardy"]);
  expect(traits[0].text).toBe("A testfolk always knows which way is down.");
  expect(traits[2].text).toBe(
    "Testfolk shrug off invented poisons. The Taste Test never fails them.",
  );
});

test("skips the section's own title, stat lines, and number tables", () => {
  const classSpan = [
    "Tester",
    "Invented testers who test things.",
    "Prime Abilities   Wisdom",
    "",
    "Test Sense",
    "A tester notices untested code.",
    "",
    "Pick",
    "Lock Test Skill",
    "1 2 3 4 5 6 7 8 9 10 11 12",
  ].join("\n");
  const traits = extractTraits([classSpan], 0, 1, "Tester");
  expect(traits.map((t) => t.name)).toEqual(["Test Sense"]);
});

test("all-caps headings take precedence; Title-Case lines stay sub-headings", () => {
  const capsSpan = [
    "STONE SENSE",
    "A testfolk always knows which way is down.",
    "",
    "Deep Sense",
    "Underground, they also know how deep.",
  ].join("\n");
  const traits = extractTraits([capsSpan], 0, 1);
  expect(traits.map((t) => t.name)).toEqual(["Stone Sense"]);
  expect(traits[0].text).toContain("Deep Sense");
});
