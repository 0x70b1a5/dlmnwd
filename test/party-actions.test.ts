import { expect, test } from "bun:test";
import type { ParsedClass } from "../src/parse/class.ts";
import {
  allowedCount,
  applyCoins,
  applyHp,
  findRune,
  forgetName,
  learnName,
  matchName,
  moveCoins,
  setField,
} from "../src/party/actions.ts";
import { blankPc, normalizeParty } from "../src/party/model.ts";
import { emptyRules, rulesFromLookups } from "../src/party/rules.ts";

// Invented names and numbers only: none of these come from any book.

const klass: ParsedClass = {
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
  traits: [],
  startingEquipment: null,
  spellBooks: [],
  advancement: [
    {
      level: 1,
      xp: 0,
      hitPoints: "1d6",
      attack: 0,
      saves: { doom: 12, ray: 13, hold: 14, blast: 15, spell: 16 },
      extras: { Glamours: "1" },
    },
    {
      level: 2,
      xp: 1000,
      hitPoints: "1d6",
      attack: 1,
      saves: { doom: 11, ray: 12, hold: 13, blast: 14, spell: 15 },
      extras: { Glamours: "2" },
    },
  ],
} as ParsedClass;

test("applies coin changes and refuses to overspend", () => {
  const c = { cp: 0, sp: 5, gp: 10, pp: 0 };
  applyCoins(c, "+120gp");
  applyCoins(c, "-2sp");
  applyCoins(c, "=7cp");
  expect(c).toEqual({ cp: 7, sp: 3, gp: 130, pp: 0 });
  expect(() => applyCoins(c, "-9sp")).toThrow("Only 3sp");
  expect(() => applyCoins(c, "lots")).toThrow("Can't read");
});

test("moves coins between purses", () => {
  const carried = { cp: 0, sp: 0, gp: 30, pp: 0 };
  const banked = { cp: 0, sp: 0, gp: 0, pp: 0 };
  moveCoins(carried, banked, "gp", 20, "Bo");
  expect([carried.gp, banked.gp]).toEqual([10, 20]);
  expect(() => moveCoins(carried, banked, "gp", 11, "Bo")).toThrow("Bo has only 10gp");
});

test("damages, heals up to the maximum, and restores HP", () => {
  const pc = blankPc("Bo");
  pc.maxHp = 8;
  pc.hp = 8;
  applyHp(pc, "-10");
  expect(pc.hp).toBe(-2);
  applyHp(pc, "+20");
  expect(pc.hp).toBe(8);
  applyHp(pc, "=3");
  applyHp(pc, "max");
  expect(pc.hp).toBe(8);
  expect(() => applyHp(pc, "a lot")).toThrow();
});

test("matches a name exactly, then by prefix, then by part", () => {
  const known = ["Ember Wisp", "Wisp Lantern", "Hollow Step"];
  expect(matchName(known, "wisp lantern")).toBe("Wisp Lantern");
  expect(matchName(known, "wisp")).toBe("Wisp Lantern");
  expect(matchName(known, "step")).toBe("Hollow Step");
  expect(matchName(known, "")).toBeUndefined();
});

test("learns names from the book's list, and forgets them", () => {
  const pc = blankPc("Bo");
  const known = ["Ember Wisp", "Hollow Step"];
  expect(learnName(pc, "glamours", known, "ember")).toBe("Ember Wisp");
  expect(() => learnName(pc, "glamours", known, "Ember Wisp")).toThrow("already knows");
  expect(() => learnName(pc, "glamours", known, "Moon Song")).toThrow("isn't one of the book's");
  expect(learnName(pc, "glamours", known, "Moon Song", { force: true })).toBe("Moon Song");
  expect(learnName(pc, "glamours", known, "", { random: true })).toBe("Hollow Step");
  expect(() => learnName(pc, "glamours", known, "", { random: true })).toThrow("No unknown");
  expect(forgetName(pc, "glamours", "moon")).toBe("Moon Song");
  expect(pc.glamours).toEqual(["Ember Wisp", "Hollow Step"]);
  // With no book list, any name is accepted.
  expect(learnName(pc, "spells", [], "Quiet Light")).toBe("Quiet Light");
});

test("reads the class's count for a list at the PC's level", () => {
  const rules = { ...emptyRules(), classes: [klass] };
  const pc = blankPc("Bo");
  pc.class = "warden";
  expect(allowedCount(pc, rules, "glamours")).toBe(1);
  pc.level = 2;
  expect(allowedCount(pc, rules, "glamours")).toBe(2);
  expect(allowedCount(pc, rules, "knacks")).toBeNull();
});

test("finds a known rune by part of its name", () => {
  const pc = blankPc("Bo");
  pc.runes.push({ name: "Thornward", magnitude: "lesser", times: 1, uses: [] });
  expect(findRune(pc, "thorn").name).toBe("Thornward");
  expect(() => findRune(pc, "ash")).toThrow("doesn't know a rune");
});

test("sets fields, re-reading Attack and Saves with the level", () => {
  const rules = { ...emptyRules(), classes: [klass] };
  const pc = blankPc("Bo");
  for (const kv of ["class=Warden", "level=2", "str=15", "retainer=yes", "status=retired"])
    setField(pc, rules, kv);
  expect(pc.class).toBe("warden");
  expect(pc.attack).toBe(1);
  expect(pc.saves.doom).toBe(11);
  expect(pc.scores.str).toBe(15);
  expect(pc.retainer).toBe(true);
  expect(pc.status).toBe("retired");
  expect(() => setField(pc, rules, "level=high")).toThrow("needs a number");
  expect(() => setField(pc, rules, "class=bard")).toThrow("Unknown class");
});

test("checks a party file and fills fields added later", () => {
  const party = normalizeParty({ members: [{ name: "Bo", level: 3 }] }, "x.json");
  expect(party.encumbrance).toBe("weight");
  expect(party.members[0].level).toBe(3);
  expect(party.members[0].coins).toEqual({ cp: 0, sp: 0, gp: 0, pp: 0 });
  expect(() => normalizeParty([], "x.json")).toThrow("no members list");
  expect(() => normalizeParty({ members: [{}] }, "x.json")).toThrow("without a name");
});

test("builds the rules from lookups, keeping defaults for missing tables", () => {
  const lookups: Record<string, unknown> = {
    glamours: ["Ember Wisp"],
    encumbrance: { coinsPerSlot: 50, slots: [] },
  };
  const rules = rulesFromLookups(
    <T>(name: string) => (lookups[name] as T | undefined) ?? null,
    [klass],
    [],
  );
  expect(rules.glamours).toEqual(["Ember Wisp"]);
  expect(rules.enc.coinsPerSlot).toBe(50);
  expect(rules.enc.weight).toEqual(emptyRules().enc.weight); // default kept
  expect(rules.classes).toEqual([klass]);
  expect(rules.catalog).toEqual([]);
});
