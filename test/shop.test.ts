import { expect, test } from "bun:test";
import { coinsLeft, generate, kindredSize, sizedOption, toMarkdown } from "../src/gen/character.ts";
import { buy, forSale, giveBack, priceOf, priceText } from "../src/gen/shop.ts";
import type { ParsedClass } from "../src/parse/class.ts";
import type { CatalogItem } from "../src/parse/gear.ts";
import type { ParsedKindred } from "../src/parse/kindred.ts";
import { computeAc, computeLoad } from "../src/party/encumbrance.ts";
import { characterToPc } from "../src/party/from-character.ts";
import { makeItem, resolveItem, slotStack } from "../src/party/items.ts";
import { itemSlots, normalizeParty } from "../src/party/model.ts";
import { repairParty } from "../src/party/repair.ts";
import { emptyRules, type PartyRules } from "../src/party/rules.ts";

// Invented names, prices and numbers only: none of these come from any book.

const catalog: CatalogItem[] = [
  { name: "Knapsack", kind: "container", weight: 40, section: "CONTAINERS", cost: "4" },
  { name: "Cord (40′ long)", kind: "gear", weight: 80, section: "TOOLS", cost: "2" },
  { name: "Hammer and pegs", kind: "gear", weight: 30, section: "TOOLS", cost: "3" },
  { name: "Oat sack", kind: "gear", weight: 90, section: "TOOLS", cost: "5cp" },
  { name: "Cart harness", kind: "gear", weight: 200, section: "TOOLS", cost: "120gp" },
  { name: "Rushlight", kind: "gear", weight: 10, section: "LIGHT", cost: "1 for 4" },
  { name: "Smock, plain", kind: "clothing", weight: 25, section: "CLOTHING", cost: "1" },
  { name: "Darts (sheaf of 12)", kind: "ammo", weight: 12, section: "AMMUNITION", cost: "3" },
  { name: "Pebbles", kind: "ammo", weight: 1, section: "AMMUNITION", cost: "Free" },
  { name: "Bare", kind: "armour", weight: 0, ac: "10", bulk: "None", section: "ARMOUR", cost: "–" },
  {
    name: "Hide",
    kind: "armour",
    weight: 150,
    ac: "11",
    bulk: "Light",
    section: "ARMOUR",
    cost: "15",
  },
  {
    name: "Scalework",
    kind: "armour",
    weight: 450,
    ac: "14",
    bulk: "Medium",
    section: "ARMOUR",
    cost: "1,200",
  },
  {
    name: "Bulwark",
    kind: "armour",
    weight: 120,
    ac: "+1",
    bulk: "None",
    section: "ARMOUR",
    cost: "8",
  },
  {
    name: "Hand cleaver",
    kind: "weapon",
    weight: 40,
    damage: "1d6",
    qualities: "Melee",
    section: "WEAPONS",
    cost: "6",
  },
  { name: "Orb", kind: "treasure", weight: 10, section: "TREASURE" },
];

const kindred: ParsedKindred = {
  id: "testkin",
  name: "Testkin",
  kindredType: "Mortal",
  nativeLanguages: ["Common"],
  nameColumns: ["First Name"],
  nameRows: [["Alice"], ["Bob"]],
  persona: { demeanour: ["Bold", "Calm"] },
  traits: [],
  trinkets: ["A bent spoon", "A shiny pebble"],
  backgrounds: ["Reed-cutter"],
  furArmourBonus: 2,
  physical: { age: null, lifespan: null, height: "2′ + 1d6″ (Short)", weight: null },
};

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
  startingEquipment: {
    armour: [{ roll: "1-6", item: "Hide + bulwark" }],
    weapons: [{ roll: "1-6", item: "Greatmaul (hand cleaver + 20 pebbles for Short characters)" }],
    classItems: [],
  },
  spellBooks: [],
};

const base = emptyRules();
const rules: PartyRules = {
  ...base,
  catalog,
  classes: [klass],
  kindreds: [kindred],
  enc: {
    ...base.enc,
    slots: [
      { equipped: 3, stowed: 8, speed: 40 },
      { equipped: 6, stowed: 12, speed: 20 },
    ],
  },
};
const entry = (name: string) => catalog.find((c) => c.name === name)!;
const ITEMS = Array.from({ length: 20 }, (_, i) => `Oddment ${i + 1}`);

// ── prices ─────────────────────────────────────────────────────────────────

test("a cost cell is read as copper and units", () => {
  expect(priceOf("4")).toEqual({ cp: 400, units: 1 });
  expect(priceOf("5cp")).toEqual({ cp: 5, units: 1 });
  expect(priceOf("120gp")).toEqual({ cp: 12000, units: 1 });
  expect(priceOf("1,200")).toEqual({ cp: 120000, units: 1 });
  expect(priceOf("Free")).toEqual({ cp: 0, units: 1 });
  expect(priceOf("1 for 4")).toEqual({ cp: 100, units: 4 });
  expect(priceOf("–")).toBeNull();
  expect(priceOf(undefined)).toBeNull();
  expect(priceText(priceOf("1 for 4")!)).toBe("1 gp for 4");
  expect(priceText(priceOf("Free")!)).toBe("free");
});

test("only priced items that are not treasure are for sale", () => {
  const names = forSale(catalog).map((c) => c.name);
  expect(names).not.toContain("Bare");
  expect(names).not.toContain("Orb");
  expect(names).toContain("Pebbles");
});

// ── buying ─────────────────────────────────────────────────────────────────

test("a buyer starts with ten times the coins, the trinket, and no rolled gear", () => {
  for (let i = 0; i < 30; i++) {
    const c = generate(kindred, klass, { gear: "buy", adventuringItems: ITEMS });
    expect(c.gold).toBeGreaterThanOrEqual(30);
    expect(c.gold).toBeLessThanOrEqual(180);
    expect(c.gold % 10).toBe(0);
    expect(c.bought).toEqual([]);
    expect(c.weapons).toEqual([]);
    expect(c.adventuringItems).toEqual([]);
    expect(c.loadout.armour).toBe("No armour");
    expect(kindred.trinkets).toContain(c.trinket!);
    expect(c.background).toBe("Reed-cutter");
  }
  const rolled = generate(kindred, klass, { adventuringItems: ITEMS });
  expect(rolled.bought).toBeUndefined();
  expect(rolled.gold).toBeLessThanOrEqual(18);
  expect(rolled.adventuringItems).toHaveLength(4);
});

test("buying takes coins, and the sheet lines follow what was bought", () => {
  const c = generate(kindred, klass, { gear: "buy" });
  c.gold = 40;
  c.scores.dex = 10;
  buy(c, entry("Hide"), catalog);
  buy(c, entry("Bulwark"), catalog);
  buy(c, entry("Hand cleaver"), catalog);
  buy(c, entry("Rushlight"), catalog);
  buy(c, entry("Rushlight"), catalog);
  buy(c, entry("Oat sack"), catalog);
  expect(coinsLeft(c)).toBe("8 gp 9 sp 5 cp");
  // Light armour keeps the kindred's natural bonus of 2.
  expect(c.loadout).toMatchObject({ armour: "Hide + Bulwark", baseAc: 12, ac: 14, shield: true });
  expect(c.weapons).toEqual(["Hand cleaver"]);
  expect(c.adventuringItems).toEqual(["Rushlight ×8", "Oat sack"]);
  expect(toMarkdown(c)).toContain("| 8 gp 9 sp 5 cp | |");

  expect(() => buy(c, entry("Scalework"), catalog)).toThrow(/costs 1200 gp/);
  expect(() => buy(c, entry("Bare"), catalog)).toThrow(/no price/);

  giveBack(c, "Rushlight", catalog);
  expect(c.adventuringItems).toEqual(["Rushlight ×4", "Oat sack"]);
  giveBack(c, "Hide", catalog);
  expect(c.loadout).toMatchObject({ armour: "Bulwark", baseAc: 11, ac: 13 });
  expect(coinsLeft(c)).toBe("24 gp 9 sp 5 cp");
  expect(() => giveBack(c, "Hide", catalog)).toThrow(/did not buy/);
});

test("medium armour loses the natural bonus", () => {
  const c = generate(kindred, klass, { gear: "buy" });
  c.gold = 2000;
  c.scores.dex = 10;
  buy(c, entry("Scalework"), catalog);
  expect(c.loadout).toMatchObject({ baseAc: 14, ac: 14 });
});

test("a character who rolled gear cannot buy", () => {
  const c = generate(kindred, klass, {});
  expect(() => buy(c, entry("Knapsack"), catalog)).toThrow(/rolled for gear/);
});

test("the party member carries the bought gear and the coins left", () => {
  const c = generate(kindred, klass, { gear: "buy" });
  c.gold = 40;
  for (const n of ["Hide", "Hammer and pegs", "Rushlight", "Oat sack", "Darts (sheaf of 12)"])
    buy(c, entry(n), catalog);
  const pc = characterToPc(c, rules);
  expect(pc.coins).toMatchObject({ gp: 17, sp: 9, cp: 5 });
  const item = (name: string) => pc.items.find((i) => i.name === name);
  // A name with "and" in it stays one item.
  expect(item("Hammer and pegs")).toMatchObject({ qty: 1, weight: 30 });
  expect(item("Rushlight")).toMatchObject({ qty: 4 });
  expect(item("Hide")).toMatchObject({ where: "equipped" });
  expect(item("Darts (sheaf of 12)")).toMatchObject({ qty: 1 });
  expect(pc.items.some((i) => i.name === c.trinket)).toBe(true);
  expect(computeAc(pc, catalog)).toBe(c.loadout.ac);
});

// ── gear slots of rolled gear ──────────────────────────────────────────────

test("an entry for one size of character gives that size its own item", () => {
  expect(kindredSize(kindred)).toBe("Short");
  const entryText = "Greatmaul (hand cleaver + 20 pebbles for Short characters)";
  expect(sizedOption(entryText, "Short")).toBe("Hand cleaver + 20 pebbles");
  expect(sizedOption(entryText, "Tall")).toBe("Greatmaul");
  expect(sizedOption(entryText, null)).toBe("Greatmaul");
  expect(sizedOption("Hornbow + 20 darts", "Short")).toBe("Hornbow + 20 darts");
});

test("loose ammunition packs like the list's bundles", () => {
  expect(slotStack(entry("Pebbles"), catalog)).toBe(12);
  expect(slotStack(entry("Darts (sheaf of 12)"), catalog)).toBe(1);
  expect(slotStack(entry("Knapsack"), catalog)).toBe(1);
  expect(slotStack(entry("Pebbles"), [entry("Pebbles")])).toBe(20);
  const { inv } = makeItem(catalog, rules.enc, "20 pebbles");
  expect(inv).toMatchObject({ qty: 20, slots: 1, per: 12 });
  expect(itemSlots(inv)).toBe(2);
  expect(itemSlots({ ...inv, qty: 12 })).toBe(1);
  expect(itemSlots({ name: "Thing", qty: 3, weight: 0, slots: 2, where: "stowed" })).toBe(6);
});

test("a one-word name finds the list's two-word name", () => {
  expect(resolveItem(catalog, "handcleaver").item?.name).toBe("Hand cleaver");
  expect(resolveItem(catalog, "hand-cleaver").item?.name).toBe("Hand cleaver");
});

test("rolled gear with loose ammunition does not stop the character", () => {
  for (let i = 0; i < 20; i++) {
    const c = generate(kindred, klass, { adventuringItems: [] });
    expect(c.weapons).toEqual(["Hand cleaver + 20 pebbles"]);
    const pc = characterToPc(c, rules);
    const load = computeLoad(pc, "slots", rules.enc, catalog);
    // Rations, waterskin, tinder box and backpack, and two slots of pebbles.
    expect(load.stowedSlots).toBeLessThanOrEqual(8);
    expect(load.speed).toBeGreaterThan(0);
  }
});

test("a saved member's loose ammunition is counted again by the stack", () => {
  const p = normalizeParty(
    {
      members: [
        {
          name: "Orla Venn",
          class: "warden",
          saves: klass.saves,
          items: [
            { name: "Pebbles", ref: "Pebbles", qty: 20, weight: 1, slots: 1, where: "stowed" },
            { name: "Knapsack", ref: "Knapsack", qty: 1, weight: 40, slots: 1, where: "stowed" },
          ],
        },
      ],
    },
    "test",
  );
  const fixes = repairParty(p, rules);
  expect(fixes).toHaveLength(1);
  expect(fixes[0]).toMatch(/Orla Venn: Pebbles now fill one slot for each 12/);
  expect(p.members[0].items[0].per).toBe(12);
  expect(repairParty(p, rules)).toEqual([]);
});
