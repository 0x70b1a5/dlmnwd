import { expect, test } from "bun:test";
import type { ParsedClass } from "../src/parse/class.ts";
import { setField } from "../src/party/actions.ts";
import { pcFromSheet } from "../src/party/import.ts";
import { normalizeParty } from "../src/party/model.ts";
import { fillFromClass, repairParty, savesMissing } from "../src/party/repair.ts";
import { showPc } from "../src/party/render.ts";
import { emptyRules, type PartyRules } from "../src/party/rules.ts";

// Invented names and numbers only: none of these come from any book.

const saves = (n: number) => ({ doom: n, ray: n + 1, hold: n + 2, blast: n + 3, spell: n + 4 });
const warden: ParsedClass = {
  id: "warden",
  name: "Warden",
  hitDie: "1d6",
  armour: "Any",
  weapons: "Any",
  primeAbilities: ["wis"],
  attack: 0,
  nextLevelXp: 1000,
  saves: saves(12),
  skills: {},
  languages: [],
  traits: [],
  startingEquipment: null,
  spellBooks: [],
  advancement: [
    { level: 1, xp: 0, hitPoints: "1d6", attack: 0, saves: saves(12), extras: {} },
    { level: 2, xp: 1000, hitPoints: "+1d6", attack: 1, saves: saves(11), extras: {} },
  ],
};
const rules: PartyRules = { ...emptyRules(), classes: [warden] };

function party(members: object[]) {
  return normalizeParty({ members }, "test");
}

test("a member with no saves takes them from the class row for their level", () => {
  const p = party([{ name: "Orla Venn", class: "warden", level: 2 }]);
  expect(savesMissing(p.members[0])).toBe(true);
  expect(repairParty(p, rules)).toEqual([
    "Orla Venn: Save Targets set from the Warden table (Level 2).",
  ]);
  expect(p.members[0].saves).toEqual(saves(11));
  expect(p.members[0].attack).toBe(1);
  expect(repairParty(p, rules)).toEqual([]);
});

test("saves that are set stay as they are, and so does a set attack", () => {
  const p = party([
    { name: "Bram Tolle", class: "warden", level: 2, saves: saves(9) },
    { name: "Ise Marr", class: "warden", level: 2, attack: 3 },
  ]);
  expect(repairParty(p, rules)).toHaveLength(1);
  expect(p.members[0].saves).toEqual(saves(9));
  expect(p.members[1].attack).toBe(3);
});

test("an unknown class or level leaves the saves unset and says so", () => {
  const p = party([
    { name: "Orla Venn", class: "tinker", level: 1 },
    { name: "Bram Tolle", class: "warden", level: 9 },
  ]);
  expect(repairParty(p, rules)).toEqual([]);
  expect(fillFromClass(p.members[0], rules)).toEqual({
    filled: false,
    text: "no Save Targets, and the class is not known",
  });
  expect(fillFromClass(p.members[1], rules)?.text).toContain("no Level 9");
  expect(showPc(p.members[0], p, rules)).toContain("Saves  not set");
});

test("a table with no rows still gives level 1 from the class", () => {
  const p = party([{ name: "Orla Venn", class: "warden" }]);
  const bare = { ...emptyRules(), classes: [{ ...warden, advancement: undefined }] };
  expect(repairParty(p, bare)).toHaveLength(1);
  expect(p.members[0].saves).toEqual(saves(12));
});

test("setting the class fills missing saves; a save can be set by name", () => {
  const p = party([{ name: "Orla Venn", class: "tinker" }]);
  const pc = p.members[0];
  setField(pc, rules, "class=warden");
  expect(pc.saves).toEqual(saves(12));
  setField(pc, rules, "doom=7");
  expect(pc.saves.doom).toBe(7);
});

test("a sheet with empty save boxes takes the class table's saves", () => {
  const { pc, messages } = pcFromSheet(
    { Name: "Orla Venn", "Kindred & Class": "Warden", Level: "2" },
    rules,
  );
  expect(pc.saves).toEqual(saves(11));
  expect(messages).toContain("Save Targets set from the Warden table (Level 2)");
});
