// The party rules as parsed from the Player's Book pages. build.ts stores these
// lookups in the index; the web app uses them directly. Pure: no Node APIs.

import type { ParsedClass } from "../parse/class.ts";
import { parseCatalog, parseEncumbrance } from "../parse/gear.ts";
import { parseGlamoursTable } from "../parse/glamour.ts";
import type { ParsedKindred } from "../parse/kindred.ts";
import { parseKnacksTable } from "../parse/knack.ts";
import { parseRunes } from "../parse/rune.ts";
import { kindredXpBonus, kindredXpBonuses, parsePrimeXpModifiers } from "../parse/xp.ts";
import { type PartyRules, rulesFromLookups } from "./rules.ts";

/** The lookups party management needs, keyed by their index names. */
export function partyLookups(pages: string[], kindreds: ParsedKindred[]): Record<string, unknown> {
  const prose = kindredXpBonuses(pages, kindreds);
  const kindredXp = Object.fromEntries(
    kindreds.map((k) => [k.id, kindredXpBonus(k.traits) || prose[k.id] || 0]),
  );
  return {
    catalog: parseCatalog(pages),
    encumbrance: parseEncumbrance(pages),
    runes: parseRunes(pages),
    prime_xp: parsePrimeXpModifiers(pages),
    kindred_xp: kindredXp,
    glamours: parseGlamoursTable(pages),
    knacks: parseKnacksTable(pages),
  };
}

/** The party rules straight from the book's pages. */
export function rulesFromPages(
  pages: string[],
  classes: ParsedClass[],
  kindreds: ParsedKindred[],
): PartyRules {
  const lookups = partyLookups(pages, kindreds);
  return rulesFromLookups(
    <T>(name: string) => (lookups[name] as T | undefined) ?? null,
    classes,
    kindreds,
  );
}
