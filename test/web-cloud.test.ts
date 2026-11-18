import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Merge } from "../src/party/merge.ts";
import { normalizeParty, type Party } from "../src/party/model.ts";
import { INDEX_VERSION } from "../src/version.ts";

// The account side of the web app (web/cloud.ts) against a stand-in server.
// Invented names only.

type Call = { path: string; body?: Record<string, unknown> };
let calls: Call[];
let server: { party: Party | null; version: number };
const realFetch = globalThis.fetch;
const reply = (status: number, data: unknown): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

beforeAll(() => GlobalRegistrator.register());
afterAll(() => {
  GlobalRegistrator.unregister();
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  localStorage.clear();
  calls = [];
  server = { party: null, version: 0 };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api\/dorc\//, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path === "party" && !body)
      return reply(200, { party: server.party, version: server.version, updated: 1_700_000_000 });
    if (path === "party") {
      if (body.version !== server.version)
        return reply(409, { error: "stale", version: server.version });
      server = { party: body.party, version: server.version + 1 };
      return reply(200, { version: server.version });
    }
    return reply(404, { error: "Unknown endpoint." });
  }) as typeof fetch;
});

const party = (...names: string[]): Party =>
  normalizeParty({ members: names.map((name) => ({ name })) }, "test");

function side(local: Party, answer: "mine" | "theirs" | "both" | "later" = "theirs") {
  const seen = {
    party: local,
    asked: [] as { mine: string[]; theirs: string[]; theirsAt: number | null }[],
    notes: [] as string[],
    merges: [] as (Merge | null)[],
  };
  return Object.assign(seen, {
    current: () => seen.party,
    replace: (p: Party) => (seen.party = p),
    choose: async (
      mine: Party,
      theirs: Party,
      t: { theirsAt: number | null },
      merge: Merge | null,
    ) => {
      seen.asked.push({ mine: names(mine)!, theirs: names(theirs)!, theirsAt: t.theirsAt });
      seen.merges.push(merge);
      return answer;
    },
    note: (t: string) => seen.notes.push(t),
  });
}
const names = (p: Party | null) => p?.members.map((m) => m.name);

test("the fingerprint ignores the order of words on a page, not the words", async () => {
  const { fingerprint } = await import("../web/cloud.ts");
  const a = await fingerprint(["Moss  and\nstone", "Page two"]);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(await fingerprint(["stone and Moss", "two  Page"])).toBe(a);
  expect(await fingerprint(["stone and Moss", "Page three"])).not.toBe(a);
  // A word moved to another page is another book.
  expect(await fingerprint(["Moss and", "stone Page two"])).not.toBe(a);
});

test("the account wants the book when it has none, or one from older parsers", async () => {
  const { bookWanted } = await import("../web/cloud.ts");
  const user = { id: 1, name: "Ana", avatar: null };
  const book = { fingerprint: "f1", version: INDEX_VERSION } as never;
  const m = (b: unknown) => ({ user, signIn: [], party: null, book: b }) as never;
  expect(bookWanted(m(null), book)).toBe(true);
  expect(bookWanted(m({ fingerprint: "f1", index_version: INDEX_VERSION }), book)).toBe(false);
  expect(bookWanted(m({ fingerprint: "f1", index_version: INDEX_VERSION - 1 }), book)).toBe(true);
  expect(bookWanted(m(null), { version: INDEX_VERSION } as never)).toBe(false); // no fingerprint
  expect(bookWanted({ user: null, signIn: [], party: null, book: null }, book)).toBe(false);
});

test("an account with no party takes this browser's", async () => {
  const { partySync } = await import("../web/cloud.ts");
  const s = side(party("Orla Venn"));
  await partySync(s).sync(7);
  expect(names(server.party)).toEqual(["Orla Venn"]);
  expect(server.version).toBe(1);
  expect(s.asked).toEqual([]);
});

test("a browser with no changes takes the account's party without asking", async () => {
  const { partySync } = await import("../web/cloud.ts");
  server = { party: party("Bram", "Cole"), version: 4 };
  const s = side(party("Orla Venn"));
  localStorage.setItem("dlmnwd:cloud", JSON.stringify({ user: 7, version: 2, changed: false }));
  await partySync(s).sync(7);
  expect(names(s.party)).toEqual(["Bram", "Cole"]);
  expect(s.asked).toEqual([]);
  expect(calls.filter((c) => c.body)).toEqual([]);
});

test("both changed: the user chooses, and keeping this one replaces the account's", async () => {
  const { partySync } = await import("../web/cloud.ts");
  server = { party: party("Bram"), version: 4 };
  localStorage.setItem("dlmnwd:cloud", JSON.stringify({ user: 7, version: 2, changed: true }));
  const keep = side(party("Orla Venn"), "mine");
  await partySync(keep).sync(7);
  expect(keep.asked[0]).toEqual({
    mine: ["Orla Venn"],
    theirs: ["Bram"],
    theirsAt: 1_700_000_000_000,
  });
  expect(names(keep.party)).toEqual(["Orla Venn"]);
  expect(names(server.party)).toEqual(["Orla Venn"]);
  expect(server.version).toBe(5);

  server = { party: party("Bram"), version: 9 };
  localStorage.setItem("dlmnwd:cloud", JSON.stringify({ user: 7, version: 5, changed: true }));
  const take = side(party("Orla Venn"), "theirs");
  await partySync(take).sync(7);
  expect(names(take.party)).toEqual(["Bram"]);
  expect(server.version).toBe(9);
});

test("a change is sent after a pause, and a stale save asks again", async () => {
  const { partySync } = await import("../web/cloud.ts");
  const s = side(party("Orla Venn"), "theirs");
  const sync = partySync(s);
  await sync.sync(7); // version 1 on the server
  s.party = party("Orla Venn", "Bram");
  sync.changed();
  sync.changed(); // one save for both
  await new Promise((r) => setTimeout(r, 1400));
  expect(calls.filter((c) => c.body).length).toBe(2);
  expect(names(server.party)).toEqual(["Orla Venn", "Bram"]);
  // Another browser saved in between: this one is stale, and the user is asked.
  server = { party: party("Cole"), version: 7 };
  s.party = party("Orla Venn");
  sync.changed();
  await new Promise((r) => setTimeout(r, 1400));
  expect(s.asked).toHaveLength(1);
  expect(names(s.party)).toEqual(["Cole"]);
  sync.stop();
});

test("decide later sends and takes nothing, and pauses until the next check", async () => {
  const { partySync } = await import("../web/cloud.ts");
  server = { party: party("Bram"), version: 4 };
  localStorage.setItem("dlmnwd:cloud", JSON.stringify({ user: 7, version: 2, changed: true }));
  const s = side(party("Orla Venn"), "later");
  const sync = partySync(s);
  await sync.sync(7);
  expect(names(s.party)).toEqual(["Orla Venn"]);
  expect(names(server.party)).toEqual(["Bram"]);
  sync.changed();
  await new Promise((r) => setTimeout(r, 1400));
  expect(calls.filter((c) => c.body)).toEqual([]);
  expect(s.asked).toHaveLength(1);
  await sync.sync(7); // the next check asks again
  expect(s.asked).toHaveLength(2);
  sync.stop();
});

test("the dialog shows both sides, the differences, and resolves with the choice", async () => {
  const { chooseParty } = await import("../web/conflict.ts");
  const mine = normalizeParty(
    {
      day: 3,
      members: [
        { name: "Orla Venn", level: 2, hp: 5, maxHp: 9, updated: Date.UTC(2026, 10, 1, 12) },
        { name: "Bram", level: 1 },
      ],
    },
    "test",
  );
  const theirs = normalizeParty(
    {
      day: 4,
      members: [
        { name: "Orla Venn", level: 2, hp: 9, maxHp: 9 },
        { name: "Cole", level: 1 },
      ],
    },
    "test",
  );
  const done = chooseParty(mine, theirs, {
    mineAt: Date.UTC(2026, 10, 1, 12),
    theirsAt: null,
    describe: (pc) => `Wisp Warden ${pc.level}`,
  });
  const dialog = document.querySelector("dialog.conflict")!;
  const text = dialog.textContent!;
  expect(text).toContain("This browser");
  expect(text).toContain("Wisp Warden 2");
  expect(text).toContain("last change not recorded");
  expect(text).toContain("Day: 3 → 4");
  expect(text).toContain("HP: 5/9 → 9/9");
  expect(text).toContain("only in this browser");
  expect(text).toContain("only on the account");
  dialog.querySelector<HTMLButtonElement>('[data-choice="theirs"]')!.click();
  expect(await done).toBe("theirs");
  expect(document.querySelector("dialog.conflict")).toBeNull();
});

test("keep both merges against the last shared party, and saves the result", async () => {
  const { partySync } = await import("../web/cloud.ts");
  const s = side(party("Orla Venn"), "both");
  const sync = partySync(s);
  await sync.sync(7); // the account takes this party: the shared base
  // The account gains a member elsewhere; this browser gains another.
  server = { party: party("Orla Venn", "Bram"), version: server.version + 1 };
  s.party = party("Orla Venn", "Cole");
  sync.changed();
  await new Promise((r) => setTimeout(r, 1400));
  expect(s.merges[0]?.clashes).toEqual([]);
  expect(names(s.party)).toEqual(["Orla Venn", "Cole", "Bram"]);
  expect(names(server.party)).toEqual(["Orla Venn", "Cole", "Bram"]);
  sync.stop();
});

test("with no shared party yet, the dialog gets no merge", async () => {
  const { partySync } = await import("../web/cloud.ts");
  server = { party: party("Bram"), version: 4 };
  localStorage.setItem("dlmnwd:cloud", JSON.stringify({ user: 7, version: 2, changed: true }));
  const s = side(party("Orla Venn"), "later");
  await partySync(s).sync(7);
  expect(s.merges).toEqual([null]);
});

test("the dialog offers keep both only when nothing clashes", async () => {
  const { chooseParty } = await import("../web/conflict.ts");
  const { mergeParties } = await import("../src/party/merge.ts");
  const base = normalizeParty({ members: [{ name: "Orla Venn", hp: 5, maxHp: 9, xp: 0 }] }, "t");
  const here = structuredClone(base);
  here.members[0].hp = 9;
  const there = structuredClone(base);
  there.members[0].xp = 120;
  const info = { mineAt: null, theirsAt: null, describe: () => "" };
  let done = chooseParty(here, there, { ...info, merge: mergeParties(base, here, there) });
  let dialog = document.querySelector("dialog.conflict")!;
  expect(dialog.textContent).toContain("From this browser");
  expect(dialog.textContent).toContain("Orla Venn: HP");
  expect(dialog.textContent).toContain("Orla Venn: XP");
  dialog.querySelector<HTMLButtonElement>('[data-choice="both"]')!.click();
  expect(await done).toBe("both");

  there.members[0].hp = 1; // now both changed HP
  done = chooseParty(here, there, { ...info, merge: mergeParties(base, here, there) });
  dialog = document.querySelector("dialog.conflict")!;
  expect(dialog.querySelector('[data-choice="both"]')).toBeNull();
  expect(dialog.textContent).toContain("each side changed the same thing");
  dialog.querySelector<HTMLButtonElement>('[data-choice="later"]')!.click();
  await done;

  done = chooseParty(here, there, { ...info, merge: null });
  dialog = document.querySelector("dialog.conflict")!;
  expect(dialog.textContent).toContain("no copy of the party");
  dialog.querySelector<HTMLButtonElement>('[data-choice="later"]')!.click();
  await done;
});
