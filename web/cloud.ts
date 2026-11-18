// Saves on a server, for a deploy that names one at build time
// (DW_PUBLIC_CLOUD=https://… bun run web:build). With none, the app keeps
// everything in this browser only and shows nothing of this.
//
// The server is a MORC instance (crom: cromweb/dorc.py). The browser signs in
// there with Discord and calls it with that session's cookie. It keeps the
// party, and the account's own parsed copy of its Player's Book: the rules this
// page reads out of the PDF. The PDF itself is never sent. The book is kept only
// when the server knows its fingerprint, so a wrong PDF is never stored.

import type { Party } from "../src/party/model.ts";
import { normalizeParty } from "../src/party/model.ts";
import { INDEX_VERSION } from "../src/version.ts";
import type { Book } from "./book.ts";

/** The server's address, from the build. Empty when the deploy has none. The
 *  build writes the address in place of `process.env.…`; with none named, the
 *  name is left, and a browser has no `process`. */
function cloudBase(): string {
  try {
    return (process.env.DW_PUBLIC_CLOUD ?? "").replace(/\/+$/, "");
  } catch {
    return "";
  }
}
export const CLOUD: string = cloudBase();

export interface Me {
  user: { id: number; name: string; avatar: string | null } | null;
  signIn: { label: string; url: string }[];
  party: { version: number; updated: number } | null;
  book: { fingerprint: string; index_version: number; updated: number } | null;
}

/** A reply that was not a success, with the server's own words. */
export class CloudError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${CLOUD}/api/dorc/${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new CloudError("The server could not be reached.", 0);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok)
    throw new CloudError(String(data.error ?? `The server said ${res.status}.`), res.status, data);
  return data as T;
}

export const me = (): Promise<Me> => call<Me>("me");
export const signOut = (): Promise<unknown> => call("sign-out", {});

// ── the book ────────────────────────────────────────────────────────────────

/**
 * A fingerprint of the book's text: each page's words, sorted, then SHA-256.
 * The order of words on a line does not change it, so small layout changes in
 * the PDF reader leave it the same. The server compares it with the right book's.
 */
export async function fingerprint(pages: string[]): Promise<string> {
  const text = pages.map((p) => p.split(/\s+/).filter(Boolean).toSorted().join(" ")).join("\n");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Keep the parsed book on the account. The fingerprint goes first, alone, so a
 *  wrong PDF sends nothing more. Throws a CloudError (422) for a wrong book. */
export async function keepBook(book: Book): Promise<void> {
  if (!book.fingerprint) throw new CloudError("Load the PDF again to keep the book here.", 0);
  await call("book", { fingerprint: book.fingerprint });
  await call("book", { fingerprint: book.fingerprint, index_version: book.version, book });
}

/** The account's book, when it was read by the parsers this page has. */
export async function accountBook(): Promise<Book | null> {
  const got = await call<{ book: Book | null; index_version?: number }>("book");
  if (!got.book || got.index_version !== INDEX_VERSION || got.book.version !== INDEX_VERSION)
    return null;
  return got.book;
}

export const forgetAccountBook = (): Promise<unknown> => call("book", { forget: true });

/** Does the account need this browser's book: none kept, or kept by older parsers? */
export function bookWanted(m: Me, book: Book | null): boolean {
  if (!m.user || !book?.fingerprint) return false;
  return (
    !m.book || m.book.index_version !== INDEX_VERSION || m.book.fingerprint !== book.fingerprint
  );
}

// ── the party ───────────────────────────────────────────────────────────────

const SYNC = "dlmnwd:cloud";
const plural = (n: number): string => `${n} member${n === 1 ? "" : "s"}`;

/** What this browser knows of the account's party: whose it is, the version it
 *  last had, and whether it has changed since. */
interface SyncState {
  user: number;
  version: number;
  changed: boolean;
  /** When this browser's party last changed (ms since 1970). */
  at?: number;
}

function readSync(): SyncState | null {
  try {
    const raw = JSON.parse(localStorage.getItem(SYNC) ?? "null");
    return raw && typeof raw.user === "number" ? raw : null;
  } catch {
    return null;
  }
}

function writeSync(s: SyncState): void {
  try {
    localStorage.setItem(SYNC, JSON.stringify(s));
  } catch {}
}

export interface PartySide {
  current(): Party;
  /** Take the account's party, no question asked. */
  replace(p: Party, said: string): void;
  /** Both changed: ask the user which to keep. */
  choose(
    mine: Party,
    theirs: Party,
    times: { mineAt: number | null; theirsAt: number | null },
  ): Promise<"mine" | "theirs" | "later">;
  /** Say what happened. */
  note(text: string, kind: "info" | "error"): void;
}

/**
 * Keep the party in this browser and on the account the same. `sync` runs on
 * sign-in and when the page comes back into view; `changed` after each change
 * here. Two browsers that both changed the party ask the user which to keep.
 */
export function partySync(side: PartySide): {
  sync(user: number): Promise<void>;
  changed(): void;
  stop(): void;
} {
  let user: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy: Promise<void> = Promise.resolve();
  // After "Decide later": changes are marked, not sent, until the next check.
  let paused = false;

  async function push(state: SyncState): Promise<void> {
    try {
      const { version } = await call<{ version: number }>("party", {
        party: side.current(),
        version: state.version,
      });
      writeSync({ user: state.user, version, changed: false, at: state.at });
    } catch (err) {
      if (err instanceof CloudError && err.status === 409) return pull(state.user);
      side.note(`The party was not saved to your account: ${(err as Error).message}`, "error");
    }
  }

  async function pull(id: number): Promise<void> {
    const known = readSync();
    const state: SyncState =
      known && known.user === id
        ? known
        : // Another account (or the first sign-in here): this browser's party is new to it.
          { user: id, version: 0, changed: side.current().members.length > 0 };
    const got = await call<{ party: unknown; version: number; updated?: number }>("party");
    if (got.version === 0) return push(state); // nothing kept yet: keep this one
    if (got.version === state.version) return state.changed ? push(state) : undefined;
    const theirs = normalizeParty(got.party, "The account's party");
    const mine = side.current();
    const same = JSON.stringify(theirs) === JSON.stringify(mine);
    if (same || !state.changed || mine.members.length === 0) {
      if (!same)
        side.replace(theirs, `The party from your account (${plural(theirs.members.length)}).`);
      writeSync({ user: id, version: got.version, changed: false });
      return;
    }
    const choice = await side.choose(mine, theirs, {
      mineAt: state.at ?? null,
      theirsAt: got.updated ? got.updated * 1000 : null,
    });
    if (choice === "theirs") {
      side.replace(theirs, `The party from your account (${plural(theirs.members.length)}).`);
      writeSync({ user: id, version: got.version, changed: false });
    } else if (choice === "mine")
      await push({ user: id, version: got.version, changed: true, at: state.at });
    else paused = true; // "later": nothing is sent or taken; the next check asks again
  }

  /** Run one step at a time, so a save and a check do not cross. */
  const queue = (step: () => Promise<void>): Promise<void> =>
    (busy = busy.then(step).catch((err) => side.note((err as Error).message, "error")));

  return {
    sync(id) {
      user = id;
      paused = false;
      return queue(() => pull(id));
    },
    changed() {
      const state = readSync();
      if (user === null) {
        // Signed out: the change is this browser's. Mark it, for the next sign-in.
        if (state) writeSync({ ...state, changed: true, at: Date.now() });
        return;
      }
      writeSync({
        user,
        version: state?.user === user ? state.version : 0,
        changed: true,
        at: Date.now(),
      });
      if (paused) return;
      clearTimeout(timer);
      const id = user;
      timer = setTimeout(
        () => void queue(() => push(readSync() ?? { user: id, version: 0, changed: true })),
        1200,
      );
    },
    stop() {
      user = null;
      clearTimeout(timer);
    },
  };
}
