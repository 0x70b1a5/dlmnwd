// The book-derived rules party management runs on, bundled so the logic stays
// pure (tests build one by hand; the CLI loads it from the index, rules-db.ts;
// the web app builds it from the PDF's pages, book.ts). Anything the book didn't
// yield falls back to the generic defaults in src/rules.ts. Pure: no Node APIs.

import type { ParsedClass } from "../parse/class.ts";
import type { CatalogItem, EncumbranceRules } from "../parse/gear.ts";
import type { ParsedKindred } from "../parse/kindred.ts";
import type { RuneRules } from "../parse/rune.ts";
import type { XpBand } from "../parse/xp.ts";
import { DEFAULT_PRIME_XP, DEFAULT_WEIGHT_BANDS } from "../rules.ts";

export interface PartyRules {
  catalog: CatalogItem[];
  enc: EncumbranceRules;
  runes: RuneRules;
  primeXp: XpBand[];
  kindredXp: Record<string, number>;
  classes: ParsedClass[];
  kindreds: ParsedKindred[];
  glamours: string[];
  knacks: string[];
}

export function defaultEnc(): EncumbranceRules {
  return {
    weight: DEFAULT_WEIGHT_BANDS,
    slots: [],
    slotsPerContainer: 0,
    stowContainers: [],
    basic: {},
    zeroSlot: [],
    bulky: [],
    coinsPerSlot: 100,
    trinketWeight: 0,
  };
}

export function emptyRules(): PartyRules {
  return {
    catalog: [],
    enc: defaultEnc(),
    runes: { runes: [], usage: {}, granted: [], levelBonus: [] },
    primeXp: DEFAULT_PRIME_XP,
    kindredXp: {},
    classes: [],
    kindreds: [],
    glamours: [],
    knacks: [],
  };
}

/**
 * Assemble the rules from the book's lookup tables (by their index names) and
 * its classes and kindreds. Missing pieces fall back to the defaults, so the
 * party still works without a book.
 */
export function rulesFromLookups(
  get: <T>(name: string) => T | null,
  classes: ParsedClass[],
  kindreds: ParsedKindred[],
): PartyRules {
  const r = emptyRules();
  const enc = get<Partial<EncumbranceRules>>("encumbrance") ?? {};
  const prime = get<XpBand[]>("prime_xp");
  return {
    catalog: get<CatalogItem[]>("catalog") ?? r.catalog,
    // Drop empty parsed lists so a missed table keeps its default.
    enc: {
      ...r.enc,
      ...Object.fromEntries(
        Object.entries(enc).filter(([, v]) => !(Array.isArray(v) && v.length === 0)),
      ),
    },
    runes: get<RuneRules>("runes") ?? r.runes,
    primeXp: prime && prime.length > 0 ? prime : r.primeXp,
    kindredXp: get<Record<string, number>>("kindred_xp") ?? {},
    classes,
    kindreds,
    glamours: get<string[]>("glamours") ?? [],
    knacks: get<string[]>("knacks") ?? [],
  };
}

export function classOf(rules: PartyRules, id: string): ParsedClass | undefined {
  return rules.classes.find((c) => c.id === id);
}

export function kindredOf(rules: PartyRules, id: string): ParsedKindred | undefined {
  return rules.kindreds.find((k) => k.id === id);
}
