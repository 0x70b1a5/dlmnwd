// The party in the browser: kept in this browser's local storage, never sent
// anywhere. Export and import use the same JSON file as the CLI's party.json,
// so a party can move between `dw party` and the web app.

import { freshParty, normalizeParty, type Party } from "../src/party/model.ts";

const KEY = "dlmnwd:party";

/** The saved party, or a fresh one. Throws if the saved data can't be read, so
 *  the caller can warn before anything overwrites it. */
export function loadStoredParty(): Party {
  let text: string | null = null;
  try {
    text = localStorage.getItem(KEY);
  } catch {
    return freshParty(); // storage blocked (private window, previews): start empty
  }
  if (!text) return freshParty();
  try {
    return normalizeParty(JSON.parse(text), "The saved party");
  } catch (err) {
    // Keep the unreadable data aside, so a later save can't destroy it.
    try {
      localStorage.setItem(`${KEY}:unreadable`, text);
    } catch {}
    const why = err instanceof SyntaxError ? "is not valid JSON" : (err as Error).message;
    throw new Error(`The saved party couldn't be read (${why}). A copy is kept in this browser.`, {
      cause: err,
    });
  }
}

/** Save the party. Returns false when the browser won't store it. */
export function storeParty(party: Party): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(party));
    return true;
  } catch {
    return false;
  }
}

/** The party as a party.json file, as `dw party` writes it. */
export function partyJson(party: Party): string {
  return JSON.stringify(party, null, 2) + "\n";
}

/** Read a party.json file. */
export async function readPartyFile(file: File): Promise<Party> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    throw new Error(`${file.name} is not valid JSON.`);
  }
  return normalizeParty(raw, file.name);
}

/** Offer text to the user as a file download. */
export function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Revoke on the next macrotask so the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A file name made safe from a character's name. */
export function safeName(name: string, fallback: string): string {
  return name.replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
}
