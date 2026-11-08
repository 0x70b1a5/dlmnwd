// The party file: the model in model.ts, persisted as one JSON file on this
// machine. This is campaign state the user creates, not something derived from
// the books, so it lives in the user's data directory rather than the cache:
// $DW_PARTY → $XDG_DATA_HOME/dw/party.json → ~/.local/share/dw/party.json.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { freshParty, normalizeParty, type Party } from "./model.ts";

export * from "./model.ts";

export function partyPath(): string {
  const env = process.env.DW_PARTY?.trim();
  if (env) return env;
  const base = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(base, "dw", "party.json");
}

export function loadParty(): Party {
  const path = partyPath();
  if (!existsSync(path)) return freshParty();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    // Never silently replace a party file we can't read: it is the user's data.
    throw new Error(
      `Party file ${path} is not valid JSON (${(e as Error).message}); fix or move it.`,
      { cause: e },
    );
  }
  return normalizeParty(raw, `Party file ${path}`);
}

/** Write atomically (temp file + rename) so a crash can't truncate the party. */
export function saveParty(party: Party): void {
  const path = partyPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(party, null, 2) + "\n");
  renameSync(tmp, path);
}
