import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type Character, coinsLeft, generate } from "../src/gen/character.ts";
import type { ParsedClass } from "../src/parse/class.ts";
import type { CatalogItem } from "../src/parse/gear.ts";
import type { ParsedKindred } from "../src/parse/kindred.ts";

// The shop over a generated sheet, in a scripted DOM. Invented content only.

const catalog: CatalogItem[] = [
  { name: "Knapsack", kind: "container", weight: 40, section: "CONTAINERS", cost: "4" },
  { name: "Cart harness", kind: "gear", weight: 200, section: "TOOLS", cost: "900" },
  { name: "Rushlight", kind: "gear", weight: 10, section: "TOOLS", cost: "1 for 4" },
  { name: "Orb", kind: "treasure", weight: 10, section: "TREASURE" },
];
const kindred: ParsedKindred = {
  id: "testkin",
  name: "Testkin",
  kindredType: "Mortal",
  nativeLanguages: ["Common"],
  nameColumns: ["First Name"],
  nameRows: [["Alice"]],
  persona: {},
  traits: [],
  trinkets: ["A bent spoon"],
  backgrounds: [],
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
  startingEquipment: null,
  spellBooks: [],
};

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

test("the shop shows for a buyer, sells what the coins allow, and takes gear back", async () => {
  const { mountShop } = await import("../web/shop.ts");
  document.body.innerHTML = '<section id="shop" hidden></section>';
  const root = document.getElementById("shop")!;
  const seen: Character[] = [];
  const shop = mountShop(root, (c) => seen.push(c));
  const label = (l: string) => root.querySelector<HTMLButtonElement>(`[aria-label="${l}"]`);
  const openFold = (key: string) => {
    const d = root.querySelector<HTMLDetailsElement>(`details[data-key="${key}"]`)!;
    d.open = true;
    d.dispatchEvent(new Event("toggle"));
  };

  // A character who rolled gear gets no shop.
  shop.show(generate(kindred, klass, {}), catalog);
  expect(root.hidden).toBe(true);

  const c = generate(kindred, klass, { gear: "buy" });
  c.gold = 10;
  shop.show(c, catalog);
  expect(root.hidden).toBe(false);
  expect(root.textContent).toContain("10 gp left");
  expect(root.textContent).toContain("Nothing bought yet");
  // Treasure has no price, so no section.
  expect(root.querySelectorAll("details")).toHaveLength(2);
  // A closed section holds no rows.
  expect(label("Buy Knapsack")).toBeNull();

  openFold("CONTAINERS");
  openFold("TOOLS");
  expect(label("Buy Cart harness")!.disabled).toBe(true);
  label("Buy Knapsack")!.click();
  label("Buy Rushlight")!.click();
  expect(coinsLeft(c)).toBe("5 gp");
  expect(root.textContent).toContain("5 gp left");
  expect(root.textContent).toContain("Rushlight ×4");
  expect(seen.at(-1)).toBe(c);
  // The open sections stay open after a change.
  expect(label("Buy Knapsack")).not.toBeNull();

  label("Give back Knapsack")!.click();
  expect(coinsLeft(c)).toBe("9 gp");
  expect(c.bought!.map((b) => b.name)).toEqual(["Rushlight"]);

  shop.show(null, []);
  expect(root.hidden).toBe(true);
  expect(root.children).toHaveLength(0);
});
