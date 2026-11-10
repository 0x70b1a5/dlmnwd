import { expect, test } from "bun:test";
import { type ParsedClass, parseSpellsPerDay } from "../src/parse/class.ts";
import { forgetName, newDay } from "../src/party/actions.ts";
import { normalizeParty } from "../src/party/model.ts";
import { showPc } from "../src/party/render.ts";
import { emptyRules, type PartyRules } from "../src/party/rules.ts";
import {
  castSpell,
  classTradition,
  clearSpell,
  preparable,
  prepareSpell,
  slotLine,
  slotUse,
  spellSlots,
} from "../src/party/spells.ts";

// Invented names, traditions and numbers only: none of these come from any book.

/** A line with each text at its column, as `pdftotext -layout` gives it. */
function at(cells: [number, string][]): string {
  let line = "";
  for (const [col, text] of cells) line = line.padEnd(col) + text;
  return line;
}

const row = (level: number, counts: (number | "-")[]): string =>
  at([[4, String(level)], ...counts.map((c, i): [number, string] => [12 + i * 5, String(c)])]);

test("a spells-per-day table gives one row for each level, a dash as zero", () => {
  const page = [
    at([[2, "WARDEN SPELLS PER DAY"]]),
    at([[14, "Spell Rank"]]),
    at([
      [2, "Level"],
      [12, "1"],
      [17, "2"],
      [22, "3"],
    ]),
    row(1, [1, "-", "-"]),
    row(2, [2, "-", "-"]),
    row(3, [2, 1, "-"]),
    row(4, [3, 2, 1]),
    "",
    at([[2, "A warden who rests can change the spells they hold."]]),
  ].join("\n");
  expect(parseSpellsPerDay(page)).toEqual([
    [1, 0, 0],
    [2, 0, 0],
    [2, 1, 0],
    [3, 2, 1],
  ]);
});

test("a table given one column at a time reads the same, and side text is left out", () => {
  const col = (x: number, values: (number | "-")[]): string[] =>
    values.map((v) => at([[x, String(v)]]));
  const page = [
    at([
      [14, "Spell Rank"],
      [40, "Other notes"],
    ]),
    at([
      [2, "Level"],
      [12, "1"],
      [17, "2"],
      [40, "A second column of prose 7"],
    ]),
    ...col(4, [1, 2, 3]),
    ...col(12, [1, 2, 2]),
    ...col(17, ["-", "-", 1]),
  ].join("\n");
  expect(parseSpellsPerDay(page)).toEqual([
    [1, 0],
    [2, 0],
    [2, 1],
  ]);
});

test("a page with no such table gives null", () => {
  expect(parseSpellsPerDay("Level 1 2 3\n  1  2  3")).toBeNull();
  expect(parseSpellsPerDay(at([[14, "Spell Rank"]]) + "\nno header here")).toBeNull();
});

const base: ParsedClass = {
  id: "warden",
  name: "Warden",
  hitDie: "1d6",
  armour: "Any",
  weapons: "Any",
  primeAbilities: ["wis"],
  attack: 0,
  nextLevelXp: 1000,
  saves: { doom: 12, ray: 13, hold: 14, blast: 15, spell: 16 },
  skills: {},
  languages: [],
  traits: [
    { name: "Vesper Magic", text: "A warden casts vesper spells. Vesper spells need a bell." },
    { name: "Lore", text: "A warden can read a tallow spell scroll." },
  ],
  startingEquipment: null,
  spellBooks: [],
  spellsPerDay: [
    [1, 0],
    [2, 1],
  ],
};
const scribe: ParsedClass = {
  ...base,
  id: "scribe",
  name: "Scribe",
  traits: [{ name: "Tallow Magic", text: "A scribe learns tallow spells from a book." }],
  spellBooks: [{ name: "The Ash Primer", spells: ["Moth Ward"] }],
};
const rules: PartyRules = {
  ...emptyRules(),
  classes: [base, scribe, { ...base, id: "porter", name: "Porter", spellsPerDay: undefined }],
  spells: [
    { name: "Lantern Hush", tradition: "Vesper", rank: 1 },
    { name: "Brine Thread", tradition: "Vesper", rank: 1 },
    { name: "Gull Oath", tradition: "Vesper", rank: 2 },
    { name: "Moth Ward", tradition: "Tallow", rank: 1 },
    { name: "Kiln Sleep", tradition: "Tallow", rank: 2 },
  ],
};

function member(over: object) {
  return normalizeParty({ members: [{ name: "Orla Venn", class: "warden", ...over }] }, "test");
}

test("the slots follow the class table and the level", () => {
  const pc = member({ level: 2 }).members[0];
  expect(spellSlots(pc, rules)).toEqual([2, 1]);
  expect(spellSlots({ ...pc, level: 9 }, rules)).toBeNull();
  expect(spellSlots({ ...pc, class: "porter" }, rules)).toBeNull();
  expect(member({}).members[0].prepared).toEqual([]);
});

test("the tradition is the one the class text names most", () => {
  const pc = member({}).members[0];
  expect(classTradition(pc, rules)).toBe("Vesper");
  expect(classTradition({ ...pc, class: "scribe" }, rules)).toBe("Tallow");
  expect(classTradition({ ...pc, class: "porter" }, rules)).toBeNull();
});

test("a caster with no spell book prepares from the tradition, by the Ranks it has", () => {
  const p = member({ level: 1 });
  const pc = p.members[0];
  expect(preparable(pc, rules).map((s) => s.name)).toEqual(["Lantern Hush", "Brine Thread"]);
  pc.level = 2;
  expect(preparable(pc, rules).map((s) => s.name)).toContain("Gull Oath");
});

test("a class with spell books prepares only the spells the member knows", () => {
  const pc = member({ class: "scribe", level: 2 }).members[0];
  expect(preparable(pc, rules)).toEqual([]);
  pc.spells = ["Kiln Sleep"];
  expect(preparable(pc, rules).map((s) => s.name)).toEqual(["Kiln Sleep"]);
  expect(() => prepareSpell(pc, rules, "moth")).toThrow(/can't prepare Moth Ward/);
  expect(prepareSpell(pc, rules, "kiln")).toBe("Kiln Sleep");
  forgetName(pc, "spells", "kiln");
  expect(pc.prepared).toEqual([]);
});

test("prepare fills a slot of the spell's Rank and stops when none is free", () => {
  const pc = member({ level: 2 }).members[0];
  expect(prepareSpell(pc, rules, "lantern")).toBe("Lantern Hush");
  expect(prepareSpell(pc, rules, "Lantern Hush")).toBe("Lantern Hush");
  expect(() => prepareSpell(pc, rules, "brine")).toThrow(/no Rank 1 slot free \(2 at level 2\)/);
  expect(prepareSpell(pc, rules, "brine", true)).toBe("Brine Thread");
  expect(() => prepareSpell(pc, rules, "nothing")).toThrow(/no spell matching/);
  expect(slotUse(pc, rules)).toEqual([
    { rank: 1, slots: 2, filled: 3, ready: 3 },
    { rank: 2, slots: 1, filled: 0, ready: 0 },
  ]);
});

test("cast spends one prepared copy, and a rest brings each one back", () => {
  const p = member({ level: 2 });
  const pc = p.members[0];
  prepareSpell(pc, rules, "lantern");
  prepareSpell(pc, rules, "lantern");
  prepareSpell(pc, rules, "gull");
  expect(castSpell(pc, "lantern")).toBe("Lantern Hush");
  expect(slotLine(pc, rules)).toBe("Rank 1 1/2 ready · Rank 2 1/1 ready");
  castSpell(pc, "lantern");
  expect(() => castSpell(pc, "lantern")).toThrow(/already cast Lantern Hush/);
  expect(() => castSpell(pc, "brine")).toThrow(/no prepared spell/);
  expect(showPc(pc, p, rules)).toContain(
    "Prepared Lantern Hush (cast), Lantern Hush (cast), Gull Oath",
  );
  expect(newDay(p)).toBe(2);
  expect(p.day).toBe(2);
  expect(pc.prepared.every((s) => !s.cast)).toBe(true);
});

test("clear takes a cast copy out first", () => {
  const pc = member({ level: 2 }).members[0];
  prepareSpell(pc, rules, "lantern");
  prepareSpell(pc, rules, "lantern");
  castSpell(pc, "lantern");
  expect(clearSpell(pc, "lantern")).toBe("Lantern Hush");
  expect(pc.prepared).toEqual([{ name: "Lantern Hush", cast: false }]);
});
