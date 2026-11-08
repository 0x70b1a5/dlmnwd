// A freshly rolled character (gen/character.ts) as a party member. Pure.

import { type Character, resolvedKindredTraits } from "../gen/character.ts";
import { pick } from "../util.ts";
import { computeAc } from "./encumbrance.ts";
import { addItem, makeItem } from "./items.ts";
import { blankPc, type PC } from "./model.ts";
import type { PartyRules } from "./rules.ts";
import { grantRune } from "./runes.ts";

/** Turn a freshly rolled character into a party member, resolving the rolled
 *  gear against the book's equipment lists. */
export function characterToPc(c: Character, rules: PartyRules): PC {
  const pc = blankPc(c.name);
  Object.assign(pc, {
    player: c.player,
    kindred: c.kindred.id,
    class: c.klass.id,
    alignment: c.alignment,
    background: c.background ?? "",
    scores: { ...c.scores },
    hp: c.hp,
    maxHp: c.hp,
    attack: c.klass.attack,
    saves: { ...c.klass.saves },
    magicResistance: c.magicResistance,
    skills: { ...c.skills },
    languages: [...c.languages],
    glamours: c.magic.glamours.map((g) => g.name),
    knacks: c.magic.knacks.map((k) => k.name),
    spells: c.magic.spells.map((s) => s.name),
    persona: { ...c.persona },
    physique: { ...c.physique },
  });
  // A trait rolled at level 1 shows only on the generated sheet: keep the
  // roll as a note, under the trait's own name.
  const kindredTraits = resolvedKindredTraits(c);
  const rolled = kindredTraits.find((t, i) => t !== c.kindred.traits[i]);
  if (rolled && c.symbioticFlesh) pc.notes.push(`${rolled.name} at level 1: ${c.symbioticFlesh}`);
  pc.coins.gp = c.gold;
  const { catalog, enc } = rules;
  const add = (text: string) => {
    if (text.trim()) addItem(pc, makeItem(catalog, enc, text).inv);
  };
  // "Leather armour + shield" → the armour and the shield.
  for (const part of c.loadout.armour.split(/\s*\+\s*/))
    if (!/^no armour$/i.test(part) && !/^none$/i.test(part)) add(part);
  for (const w of c.weapons) for (const part of w.split(/\s*\+\s*/)) add(part);
  for (const g of [...c.classItems, ...c.generalItems, ...c.adventuringItems]) {
    // "Backpack with rations, waterskin, and tinder box" is several things.
    for (const part of g.split(/\s*(?:,|\bwith\b|\band\b)\s*/)) add(part);
  }
  if (c.spellBook) add(`Spell book (${c.spellBook.name})`);
  // A class that starts with a random rune of some magnitude gets one now.
  const magnitude = c.klass.startingRune;
  const pool = rules.runes.runes.filter((r) => r.magnitude === magnitude);
  if (magnitude && pool.length > 0) grantRune(pc, pick(pool));
  if (c.trinket)
    pc.items.push({
      name: c.trinket,
      qty: 1,
      weight: enc.trinketWeight,
      slots: 0,
      where: "stowed",
      note: "tiny",
    });
  // Keep the generator's AC (it knows kindred armour bonuses); the difference
  // from worn gear is a standing bonus.
  pc.acBonus = c.loadout.ac - computeAc(pc, catalog);
  return pc;
}
