// Load the party rules from the SQLite index (the Player's Book rows).

import type { Database } from "bun:sqlite";
import { allClasses, allKindreds, getLookup } from "../db.ts";
import { type PartyRules, rulesFromLookups } from "./rules.ts";

export function loadRules(db: Database): PartyRules {
  return rulesFromLookups(
    <T>(name: string) => getLookup<T>(db, "players", name),
    allClasses(db),
    allKindreds(db),
  );
}
