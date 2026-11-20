import { expect, test } from "bun:test";
import type { CatalogItem } from "../src/parse/gear.ts";
import type { Transport } from "../src/parse/transport.ts";
import { coinsFor, payCoins, shiftCoins, worthCp } from "../src/party/actions.ts";
import { computeLoad, itemsWeight } from "../src/party/encumbrance.ts";
import {
  addCarrier,
  buyCarrier,
  buyItem,
  carrierLoad,
  carrierText,
  containerFill,
  destOf,
  findCarrier,
  holdersFor,
  keptText,
  moveItem,
  placeGroups,
  placeText,
  removeCarrier,
  shopCatalog,
} from "../src/party/inventory.ts";
import { addItem, makeItem, removeItem } from "../src/party/items.ts";
import { partyDiff } from "../src/party/diff.ts";
import {
  blankPc,
  emptyCoins,
  type InvItem,
  normalizeParty,
  type PC,
  tidyInventory,
} from "../src/party/model.ts";
import { emptyRules, type PartyRules } from "../src/party/rules.ts";

// Invented gear, beasts and rules: nothing here comes from any book.
const catalog: CatalogItem[] = [
  { name: "Knapsack", kind: "container", weight: 40, capacity: 300, cost: "3", section: "BAGS" },
  { name: "Hip purse", kind: "container", weight: 10, capacity: 40, cost: "1", section: "BAGS" },
  { name: "Cord (40′ long)", kind: "gear", weight: 80, cost: "1", section: "TOOLS" },
  { name: "Thimble", kind: "gear", weight: 1, cost: "2cp", section: "TOOLS" },
  { name: "Wicks", kind: "gear", weight: 3, cost: "1 for 3", section: "LIGHT" },
  { name: "Greatmaul", kind: "weapon", weight: 150, cost: "12", qualities: "Melee", section: "W" },
  { name: "Lantern pole", kind: "gear", weight: 60, cost: "1", section: "TOOLS" },
];

const beasts: Transport[] = [
  { name: "Marsh pony", kind: "animal", section: "BEASTS", cost: "35", load: 1800, speed: 70 },
  { name: "Tallow ox", kind: "animal", section: "BEASTS", cost: "60", load: 6500 },
  { name: "Mud skid", kind: "vehicle", section: "HAULAGE", cost: "45", load: 800, speed: 20 },
];

function rules(): PartyRules {
  const r = emptyRules();
  r.catalog = catalog;
  r.transport = beasts;
  r.enc = {
    ...r.enc,
    slots: [
      { equipped: 3, stowed: 8, speed: 40 },
      { equipped: 6, stowed: 12, speed: 20 },
    ],
    slotsPerContainer: 8,
    stowContainers: ["knapsack"],
    bulky: ["lantern pole"],
    coinsPerSlot: 100,
  };
  return r;
}

function member(): PC {
  const pc = blankPc("Orla Venn");
  const r = rules();
  for (const name of ["Knapsack", "Hip purse", "Cord (40′ long)", "Thimble", "Greatmaul"])
    addItem(pc, makeItem(r.catalog, r.enc, name).inv);
  return pc;
}

const by = (pc: PC, name: string): InvItem => pc.items.find((i) => i.name === name)!;
const shown = (pc: PC): string[] =>
  placeGroups(pc)
    .filter((g) => g.rows.length)
    .map(
      (g) => `${g.key}: ${g.rows.map((r) => `${"·".repeat(r.depth)}${r.item.name}`).join(", ")}`,
    );

test("each item added gets its own id", () => {
  const pc = member();
  const ids = pc.items.map((i) => i.id);
  expect(ids.every(Boolean)).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
});

test("an item put in a stowing container is stowed, and in another, takes its place", () => {
  const pc = member();
  const r = rules();
  moveItem(pc, by(pc, "Hip purse"), { where: "equipped" }, r.enc);
  moveItem(pc, by(pc, "Cord (40′ long)"), { in: by(pc, "Knapsack").id! }, r.enc);
  moveItem(pc, by(pc, "Thimble"), { in: by(pc, "Hip purse").id! }, r.enc);
  expect(by(pc, "Cord (40′ long)").where).toBe("stowed");
  expect(by(pc, "Thimble").where).toBe("equipped");
  expect(placeText(pc, by(pc, "Thimble"))).toBe("in the Hip purse");
  expect(shown(pc)).toEqual([
    "equipped: Hip purse, ·Thimble, Greatmaul",
    "stowed: Knapsack, ·Cord (40′ long)",
  ]);
});

test("what is inside goes where its container goes", () => {
  const pc = member();
  const r = rules();
  const pony = addCarrier(pc, beasts[0], "Bramble");
  moveItem(pc, by(pc, "Thimble"), { in: by(pc, "Hip purse").id! }, r.enc);
  moveItem(pc, by(pc, "Hip purse"), { in: by(pc, "Knapsack").id! }, r.enc);
  moveItem(pc, by(pc, "Knapsack"), { where: "loaded", on: pony.id }, r.enc);
  for (const n of ["Knapsack", "Hip purse", "Thimble"]) {
    expect(by(pc, n).where).toBe("loaded");
    expect(by(pc, n).on).toBe(pony.id);
  }
  // Stashed at a place: all of it is kept there.
  moveItem(pc, by(pc, "Knapsack"), { where: "stashed", kept: "at the mill" }, r.enc);
  expect(by(pc, "Thimble")).toMatchObject({ where: "stashed", kept: "at the mill" });
  expect(by(pc, "Thimble").on).toBeUndefined();
  expect(shown(pc)).toContain("stashed:at the mill: Knapsack, ·Hip purse, ··Thimble");
  // Back on the character: a stowing container's contents are stowed again.
  moveItem(pc, by(pc, "Knapsack"), { where: "equipped" }, r.enc);
  expect(by(pc, "Hip purse")).toMatchObject({ where: "stowed" });
  expect(by(pc, "Hip purse").kept).toBeUndefined();
});

test("an item can't go inside itself or what is inside it, and bulky gear isn't stowed", () => {
  const pc = member();
  const r = rules();
  moveItem(pc, by(pc, "Hip purse"), { in: by(pc, "Knapsack").id! }, r.enc);
  expect(() => moveItem(pc, by(pc, "Knapsack"), { in: by(pc, "Hip purse").id! }, r.enc)).toThrow(
    "inside something inside it",
  );
  expect(() => moveItem(pc, by(pc, "Knapsack"), { in: by(pc, "Knapsack").id! }, r.enc)).toThrow(
    "inside itself",
  );
  addItem(pc, makeItem(r.catalog, r.enc, "Lantern pole").inv);
  expect(by(pc, "Lantern pole").where).toBe("equipped");
  expect(() => moveItem(pc, by(pc, "Lantern pole"), { in: by(pc, "Knapsack").id! }, r.enc)).toThrow(
    "bulky",
  );
});

test("a move can also set the order shown in a place", () => {
  const pc = member();
  const r = rules();
  const first = pc.items[0];
  moveItem(pc, by(pc, "Thimble"), { where: "stowed" }, r.enc, { before: first });
  expect(pc.items[0].name).toBe("Thimble");
  moveItem(pc, by(pc, "Thimble"), { where: "stowed" }, r.enc, { after: by(pc, "Cord (40′ long)") });
  const names = pc.items.map((i) => i.name);
  expect(names.indexOf("Thimble")).toBe(names.indexOf("Cord (40′ long)") + 1);
  moveItem(pc, by(pc, "Knapsack"), { where: "stowed" }, r.enc, { last: true });
  expect(pc.items.at(-1)!.name).toBe("Knapsack");
});

test("dropping a container keeps what was in it, one level up", () => {
  const pc = member();
  const r = rules();
  moveItem(pc, by(pc, "Hip purse"), { in: by(pc, "Knapsack").id! }, r.enc);
  moveItem(pc, by(pc, "Thimble"), { in: by(pc, "Hip purse").id! }, r.enc);
  removeItem(pc, by(pc, "Hip purse"));
  expect(by(pc, "Thimble").in).toBe(by(pc, "Knapsack").id);
  removeItem(pc, by(pc, "Knapsack"));
  expect(by(pc, "Thimble").in).toBeUndefined();
});

test("an animal's load: full Speed up to its load, half Speed up to twice it", () => {
  const pc = member();
  const r = rules();
  const pony = addCarrier(pc, beasts[0]);
  const maul = by(pc, "Greatmaul");
  moveItem(pc, maul, { where: "loaded", on: pony.id }, r.enc);
  maul.qty = 10; // 1,500 coins
  expect(carrierLoad(pc, pony, "weight", r.enc)).toMatchObject({
    used: 1500,
    capacity: 1800,
    most: 3600,
    state: "normal",
    speed: 70,
  });
  maul.qty = 20;
  expect(carrierLoad(pc, pony, "weight", r.enc)).toMatchObject({ state: "slow", speed: 35 });
  maul.qty = 30;
  expect(carrierLoad(pc, pony, "weight", r.enc)).toMatchObject({ state: "over", speed: 0 });
  // Under slots: its load over the coins to a slot, and every item's slots.
  maul.qty = 2;
  expect(carrierLoad(pc, pony, "slots", r.enc)).toMatchObject({
    used: 2,
    capacity: 18,
    unit: "slots",
  });
  // What is on it is not on the character.
  expect(itemsWeight(pc)).toBe(40 + 10 + 80 + 1);
});

test("a vehicle carries its cargo and no more", () => {
  const pc = member();
  const r = rules();
  const skid = addCarrier(pc, beasts[2]);
  moveItem(pc, by(pc, "Greatmaul"), { where: "loaded", on: skid.id }, r.enc);
  by(pc, "Greatmaul").qty = 6; // 900 coins
  expect(carrierLoad(pc, skid, "weight", r.enc)).toMatchObject({ most: 800, state: "over" });
});

test("a container's fill: coins of weight, or slots for a stowing container under slots", () => {
  const pc = member();
  const r = rules();
  moveItem(pc, by(pc, "Cord (40′ long)"), { in: by(pc, "Knapsack").id! }, r.enc);
  moveItem(pc, by(pc, "Thimble"), { in: by(pc, "Hip purse").id! }, r.enc);
  expect(containerFill(pc, by(pc, "Knapsack"), "weight", r.enc, r.catalog)).toEqual({
    used: 80,
    capacity: 300,
    unit: "coins",
  });
  expect(containerFill(pc, by(pc, "Knapsack"), "slots", r.enc, r.catalog)).toEqual({
    used: 1,
    capacity: 8,
    unit: "slots",
  });
  expect(containerFill(pc, by(pc, "Hip purse"), "slots", r.enc, r.catalog)?.unit).toBe("coins");
  expect(containerFill(pc, by(pc, "Thimble"), "weight", r.enc, r.catalog)).toBeNull();
  // Over what it holds is a problem.
  by(pc, "Cord (40′ long)").qty = 4;
  const load = computeLoad(pc, "weight", r.enc, r.catalog);
  expect(load.problems).toContain("Knapsack holds 300 coins; 320 coins are in it");
});

test("the places to choose: the containers, never the item or what is in it", () => {
  const pc = member();
  const r = rules();
  moveItem(pc, by(pc, "Hip purse"), { in: by(pc, "Knapsack").id! }, r.enc);
  expect(holdersFor(pc, by(pc, "Thimble"), r.catalog).map((i) => i.name)).toEqual([
    "Knapsack",
    "Hip purse",
  ]);
  expect(holdersFor(pc, by(pc, "Knapsack"), r.catalog)).toEqual([]);
  expect(destOf("in:i3")).toEqual({ in: "i3" });
  expect(destOf("on:c1")).toEqual({ where: "loaded", on: "c1" });
  expect(destOf("stashed:at the mill")).toEqual({ where: "stashed", kept: "at the mill" });
});

test("taking an animal away stashes what was on it under its name", () => {
  const pc = member();
  const r = rules();
  const ox = addCarrier(pc, beasts[1], "Old Barley");
  moveItem(pc, by(pc, "Knapsack"), { where: "loaded", on: ox.id }, r.enc);
  moveItem(pc, by(pc, "Thimble"), { in: by(pc, "Knapsack").id! }, r.enc);
  expect(removeCarrier(pc, ox)).toContain("stashed with Old Barley");
  expect(by(pc, "Thimble")).toMatchObject({ where: "stashed", kept: "with Old Barley" });
  expect(pc.carriers).toEqual([]);
});

test("a second animal of a kind is numbered, and found by its name or kind", () => {
  const pc = blankPc("Orla Venn");
  addCarrier(pc, beasts[0]);
  const second = addCarrier(pc, beasts[0]);
  expect(second.name).toBe("Marsh pony 2");
  expect(findCarrier(pc, "pony 2")).toBe(second);
  expect(() => findCarrier(pc, "pony")).toThrow("be more specific");
  addCarrier(pc, beasts[1]);
  expect(findCarrier(pc, "tallow").type).toBe("Tallow ox");
});

test("paying takes the smallest coins first and gives change in gold, silver, copper", () => {
  const purse = { ...emptyCoins(), cp: 5, sp: 3, gp: 2 };
  const { paid, change } = payCoins(purse, 157);
  expect(worthCp(purse)).toBe(5 + 30 + 200 - 157);
  expect(
    paid.cp + paid.sp * 10 + paid.gp * 100 - (change.cp + change.sp * 10 + change.gp * 100),
  ).toBe(157);
  expect(() => payCoins({ ...emptyCoins(), gp: 1 }, 101)).toThrow("holds 1gp");
  expect(coinsFor(1234)).toEqual({ pp: 0, gp: 12, sp: 3, cp: 4 });
});

test("coins move between purses only when they are there", () => {
  const pc = blankPc("Orla Venn");
  pc.coins.gp = 10;
  shiftCoins({ ...emptyCoins(), gp: 4 }, pc.coins, pc.banked);
  expect(pc.coins.gp).toBe(6);
  expect(pc.banked.gp).toBe(4);
  expect(() => shiftCoins({ ...emptyCoins(), gp: 5 }, pc.banked, pc.coins, "the bank")).toThrow(
    "Only 4gp in the bank",
  );
  expect(() => shiftCoins(emptyCoins(), null, pc.coins)).toThrow("Give a number");
  shiftCoins({ ...emptyCoins(), sp: 7 }, null, pc.coins); // found
  expect(pc.coins.sp).toBe(7);
});

test("buying pays the book's price, in whole lots, from the purse chosen", () => {
  const pc = blankPc("Orla Venn");
  const r = rules();
  pc.coins.gp = 2;
  pc.banked.gp = 50;
  const { inv, line } = buyItem(pc, r, "Wicks", { qty: 4 });
  expect(inv.qty).toBe(6); // two lots of three
  expect(line).toContain("buys 6 × Wicks");
  expect(pc.coins.gp).toBe(0);
  expect(() => buyItem(pc, r, "Cord")).toThrow("carried coins hold 0cp");
  buyItem(pc, r, "Knapsack", { purse: "banked", to: { where: "equipped" } });
  expect(pc.banked.gp).toBe(47);
  expect(by(pc, "Knapsack").where).toBe("equipped");
  expect(() => buyItem(pc, r, "a carved spoon")).toThrow("no price");
  const { carrier } = buyCarrier(pc, beasts[0], { purse: "banked", name: "Bramble" });
  expect(carrier).toMatchObject({ name: "Bramble", type: "Marsh pony", load: 1800, speed: 70 });
  expect(pc.banked.gp).toBe(12);
});

test("a shop sells the beasts and vehicles after the gear", () => {
  const sold = shopCatalog(rules());
  expect(sold.map((i) => i.name).slice(-3)).toEqual(["Marsh pony", "Tallow ox", "Mud skid"]);
  expect(sold.at(-1)).toMatchObject({ cost: "45", capacity: 800 });
});

test("tidying gives ids and mends what points nowhere", () => {
  const raw = {
    members: [
      {
        name: "Orla Venn",
        items: [
          { name: "Satchel", qty: 1, weight: 5, slots: 0, where: "stowed" },
          { name: "Bead", qty: 1, weight: 1, slots: 0, where: "stowed", in: "nowhere" },
          { name: "Loop A", qty: 1, weight: 1, slots: 0, where: "stowed", id: "a", in: "b" },
          { name: "Loop B", qty: 1, weight: 1, slots: 0, where: "stowed", id: "b", in: "a" },
          { name: "Saddle roll", qty: 1, weight: 9, slots: 1, where: "loaded", on: "gone" },
          { name: "Twin", qty: 1, weight: 1, slots: 0, where: "stowed", id: "a" },
        ],
        carriers: [{ id: "c1", name: "", type: "Marsh pony", kind: "animal", load: "1800" }],
      },
    ],
  };
  const pc = normalizeParty(raw, "test").members[0];
  expect(new Set(pc.items.map((i) => i.id)).size).toBe(6);
  expect(by(pc, "Bead").in).toBeUndefined();
  // A loop is broken: one of the two comes out.
  expect([by(pc, "Loop A").in, by(pc, "Loop B").in].filter(Boolean)).toHaveLength(1);
  expect(by(pc, "Saddle roll").where).toBe("stashed");
  expect(pc.carriers[0]).toMatchObject({ name: "Marsh pony", load: 1800 });
  // An older file with no carriers gains an empty list.
  expect(normalizeParty({ members: [{ name: "Bram" }] }, "t").members[0].carriers).toEqual([]);
});

test("tidying puts the contents of a loaded item on the same animal", () => {
  const pc = blankPc("Orla Venn");
  pc.carriers.push({ id: "c1", name: "Bramble", type: "Marsh pony", kind: "animal", load: 1800 });
  pc.items.push(
    { name: "Gunny bag", qty: 1, weight: 5, slots: 0, where: "loaded", on: "c1", id: "i1" },
    { name: "Turnip", qty: 3, weight: 2, slots: 1, where: "stowed", id: "i2", in: "i1" },
  );
  tidyInventory(pc);
  expect(by(pc, "Turnip")).toMatchObject({ where: "loaded", on: "c1" });
});

const alone = (pc: PC) => normalizeParty({ members: [pc] }, "t");

test("the diff names where an item is, and the animals", () => {
  const a = blankPc("Orla Venn");
  const r = rules();
  addItem(a, makeItem(r.catalog, r.enc, "Knapsack").inv);
  addItem(a, makeItem(r.catalog, r.enc, "Thimble").inv);
  const b = structuredClone(a);
  moveItem(b, by(b, "Thimble"), { in: by(b, "Knapsack").id! }, r.enc);
  addCarrier(b, beasts[0], "Bramble");
  const lines = partyDiff(alone(a), alone(b)).members[0].changes;
  expect(lines).toContain("Gear only there: Thimble (in the Knapsack)");
  expect(lines).toContain("Animals and vehicles only there: Bramble (Marsh pony), carries 1800");
});

test('a place where gear is kept reads after "stashed", and a carrier shows its type', () => {
  expect(keptText("the mill")).toBe("at the mill");
  expect(keptText("with Old Barley")).toBe("with Old Barley");
  expect(keptText("under the bridge")).toBe("under the bridge");
  const pc = member();
  const r = rules();
  moveItem(pc, by(pc, "Thimble"), { where: "stashed", kept: "the mill" }, r.enc);
  expect(placeText(pc, by(pc, "Thimble"))).toBe("stashed at the mill");
  expect(carrierText(addCarrier(pc, beasts[0]))).toBe("Marsh pony");
  expect(carrierText(addCarrier(pc, beasts[0], "Bramble"))).toBe("Bramble (Marsh pony)");
});
