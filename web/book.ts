// What the web app reads from the user's Player's Book, parsed once and kept in
// this browser so a reload doesn't need the PDF again. It is the user's own copy,
// stored on their own machine like the CLI's index: never sent anywhere, never
// part of the site. INDEX_VERSION throws the saved copy away when the parsers change.

import type { SpellDetail } from "../src/gen/character.ts";
import { type ParsedClass, parseClasses } from "../src/parse/class.ts";
import { parseAdventuringItems } from "../src/parse/equipment.ts";
import {
  type GlamourEntry,
  parseGlamourDetails,
  parseGlamoursTable,
} from "../src/parse/glamour.ts";
import { type KnackEntry, parseKnacks } from "../src/parse/knack.ts";
import { type ParsedKindred, parseKindreds } from "../src/parse/kindred.ts";
import { parseSpells } from "../src/parse/spell.ts";
import { parseSymbioticFlesh } from "../src/parse/symbiotic-flesh.ts";
import { partyLookups } from "../src/party/book.ts";
import { type PartyRules, rulesFromLookups } from "../src/party/rules.ts";
import { INDEX_VERSION } from "../src/version.ts";

export interface Book {
  version: number;
  /** The PDF's file name and when it was read, to show the user. */
  fileName: string;
  readAt: string;
  classes: ParsedClass[];
  kindreds: ParsedKindred[];
  adventuringItems: string[];
  glamoursTable: string[];
  /** Glamour details by lower-case name (a Map, stored as its entries). */
  glamourDetails: [string, GlamourEntry][];
  knacks: KnackEntry[];
  symbioticFlesh: string[];
  spells: SpellDetail[];
  /** The party rules' lookup tables, by their index names (party/book.ts). */
  partyLookups: Record<string, unknown>;
}

/** Parse everything the app uses from the Player's Book pages. */
export function parseBook(pages: string[], fileName: string): Book {
  const kindreds = parseKindreds(pages);
  const glamoursTable = parseGlamoursTable(pages);
  return {
    version: INDEX_VERSION,
    fileName,
    readAt: new Date().toISOString(),
    classes: parseClasses(pages),
    kindreds,
    adventuringItems: parseAdventuringItems(pages),
    glamoursTable,
    glamourDetails: [...parseGlamourDetails(pages, glamoursTable)],
    knacks: parseKnacks(pages),
    symbioticFlesh: parseSymbioticFlesh(pages),
    spells: parseSpells(pages).map((s) => ({
      name: s.name,
      tradition: s.tradition ?? null,
      rank: s.rank ?? null,
      duration: s.duration ?? null,
      range: s.range ?? null,
      body: s.body,
      page: s.source.page,
    })),
    partyLookups: partyLookups(pages, kindreds),
  };
}

/** The party rules from a book. */
export function bookRules(book: Book): PartyRules {
  return rulesFromLookups(
    <T>(name: string) => (book.partyLookups[name] as T | undefined) ?? null,
    book.classes,
    book.kindreds,
    book.spells,
  );
}

/** Spell details by lower-case name, as the generator takes them. */
export function spellMap(book: Book): Map<string, SpellDetail> {
  return new Map(book.spells.map((s) => [s.name.toLowerCase(), s]));
}

const KEY = "dlmnwd:book";

/** The book saved in this browser, if there is one from the current parsers. */
export function loadSavedBook(): Book | null {
  try {
    const text = localStorage.getItem(KEY);
    if (!text) return null;
    const book = JSON.parse(text) as Book;
    if (book?.version !== INDEX_VERSION || !Array.isArray(book.classes)) return null;
    return book;
  } catch {
    return null; // storage blocked or unreadable: the user loads the PDF again
  }
}

/** Keep the book in this browser. Returns false when the browser won't store it. */
export function saveBook(book: Book): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(book));
    return true;
  } catch {
    return false;
  }
}

export function forgetBook(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}
