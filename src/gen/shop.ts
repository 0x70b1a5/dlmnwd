// Buy starting gear with starting coins, from the book's own price lists.
// Pure: the catalogue is passed in, and each change is made to the character.

import type { CatalogItem } from "../parse/gear.ts";
import { abilityMod, COIN_CP } from "../rules.ts";
import { type Character, coinsText, type Loadout, purseCp } from "./character.ts";

export interface Price {
  /** Copper pieces for one purchase. */
  cp: number;
  /** Units one purchase gives ("1 for 3" gives 3). */
  units: number;
}

const UNARMOURED = 10;

/**
 * Read a cost cell: "5" is gold, "5cp" names its coin, "1,000" has a comma,
 * "Free" costs nothing and "1 for 3" gives three. A dash or an empty cell is
 * not a price.
 */
export function priceOf(cost: string | undefined): Price | null {
  const t = (cost ?? "").trim().toLowerCase();
  if (t === "free") return { cp: 0, units: 1 };
  const m = t.match(/^([\d,]+)\s*(cp|sp|gp|pp)?(?:\s+for\s+(\d+))?$/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ""), 10);
  if (!Number.isFinite(n)) return null;
  const coin = (m[2] ?? "gp") as keyof typeof COIN_CP;
  return { cp: n * COIN_CP[coin], units: m[3] ? Math.max(1, parseInt(m[3], 10)) : 1 };
}

/** The listed items that have a price, in the book's order. */
export function forSale(catalog: CatalogItem[]): CatalogItem[] {
  return catalog.filter((c) => c.kind !== "treasure" && priceOf(c.cost) !== null);
}

/** "5 gp", "5 cp", "free", "1 gp for 3". */
export function priceText(p: Price): string {
  const text = p.cp === 0 ? "free" : coinsText(p.cp);
  return p.units > 1 ? `${text} for ${p.units}` : text;
}

/** The AC an armour entry gives, or its shield bonus. */
const value = (i: CatalogItem): number => parseInt((i.ac ?? "").replace("+", ""), 10) || 0;

/** "Rushlight ×4" for a sheet line. */
const line = (b: { name: string; qty: number }): string =>
  b.qty > 1 ? `${b.name} ×${b.qty}` : b.name;

/** Armour Class with the bought armour: the best body armour, plus shields. */
function boughtLoadout(c: Character, armour: CatalogItem[]): Loadout {
  let body: CatalogItem | null = null;
  let shield: CatalogItem | null = null;
  for (const a of armour) {
    if ((a.ac ?? "").startsWith("+")) {
      if (!shield || value(a) > value(shield)) shield = a;
    } else if (!body || value(a) > value(body)) body = a;
  }
  // A natural-armour bonus applies only with light or no armour.
  const light = !body || /^(none|light)$/i.test(body.bulk ?? "");
  const fur = light ? (c.kindred.furArmourBonus ?? 0) : 0;
  const baseAc = (body ? value(body) || UNARMOURED : UNARMOURED) + (shield ? value(shield) : 0);
  const names = [body?.name, shield?.name].filter(Boolean);
  return {
    armour: names.join(" + ") || "No armour",
    ac: baseAc + abilityMod(c.scores.dex) + fur,
    baseAc,
    shield: !!shield,
  };
}

/** Make the sheet's armour, weapon and item lines say what was bought. */
function showBought(c: Character, catalog: CatalogItem[]): void {
  const bought = c.bought ?? [];
  const entry = (name: string) => catalog.find((x) => x.name === name);
  const kind = (name: string) => entry(name)?.kind;
  const armour = bought.map((b) => entry(b.name)).filter((i) => i?.kind === "armour");
  c.loadout = boughtLoadout(c, armour as CatalogItem[]);
  c.weapons = bought.filter((b) => kind(b.name) === "weapon").map(line);
  c.adventuringItems = bought
    .filter((b) => kind(b.name) !== "weapon" && kind(b.name) !== "armour")
    .map(line);
}

/** Buy one listed item (one purchase of it). Throws when the coins are short. */
export function buy(c: Character, item: CatalogItem, catalog: CatalogItem[]): void {
  if (!c.bought) throw new Error(`${c.name} rolled for gear and has no coins set aside to buy it.`);
  const price = priceOf(item.cost);
  if (!price) throw new Error(`${item.name} has no price in the book.`);
  const left = purseCp(c);
  if (price.cp > left)
    throw new Error(
      `${item.name} costs ${coinsText(price.cp)}; ${c.name} has ${coinsText(left)} left.`,
    );
  const have = c.bought.find((b) => b.name === item.name);
  if (have) {
    have.qty += price.units;
    have.cp += price.cp;
  } else c.bought.push({ name: item.name, qty: price.units, cp: price.cp });
  showBought(c, catalog);
}

/** Give back one purchase of an item for what it cost. */
export function giveBack(c: Character, name: string, catalog: CatalogItem[]): void {
  const have = c.bought?.find((b) => b.name === name);
  if (!c.bought || !have) throw new Error(`${c.name} did not buy ${name}.`);
  const price = priceOf(catalog.find((x) => x.name === name)?.cost);
  const units = Math.min(have.qty, price?.units ?? 1);
  // The same share of what was paid, so an item bought twice gives back half.
  const cp = Math.round((have.cp * units) / have.qty);
  have.qty -= units;
  have.cp -= cp;
  if (have.qty <= 0) c.bought = c.bought.filter((b) => b !== have);
  showBought(c, catalog);
}
