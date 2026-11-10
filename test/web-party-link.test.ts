import { expect, test } from "bun:test";
import { blankPc, freshParty } from "../src/party/model.ts";
import { partyFromLink, partyLink } from "../web/party-link.ts";

function party() {
  const p = freshParty();
  p.day = 4;
  const pc = blankPc("Orla Venn — “the Wick”");
  pc.items.push({ name: "Tallow lamp", qty: 2, weight: 10, slots: 1, where: "stowed" });
  pc.notes.push("Owes 3gp to the ferryman ✦");
  p.members.push(pc, blankPc("Bram"));
  return p;
}

test("a link gives the party back, and keeps it out of the request", async () => {
  const link = await partyLink(party(), "https://example.test/app/?x=1#old");
  const url = new URL(link);
  expect(url.origin + url.pathname + url.search).toBe("https://example.test/app/?x=1");
  expect(url.hash).toMatch(/^#party=[\w-]+$/);
  expect(await partyFromLink(url.hash)).toEqual(party());
});

test("an address with no party gives null", async () => {
  expect(await partyFromLink("")).toBeNull();
  expect(await partyFromLink("#top")).toBeNull();
});

test("a cut or wrong link is an error the user can read", async () => {
  const link = await partyLink(party(), "https://example.test/");
  const hash = new URL(link).hash;
  expect(partyFromLink(hash.slice(0, hash.length - 12))).rejects.toThrow("can't be read");
  expect(partyFromLink("#party=%%%")).rejects.toThrow("can't be read");
  expect(partyFromLink("#party=")).rejects.toThrow("can't be read");
});

test("a party of many members makes a link a chat can carry", async () => {
  const p = freshParty();
  for (let m = 0; m < 6; m++) {
    const pc = blankPc(`Member ${m}`);
    for (let i = 0; i < 40; i++)
      pc.items.push({ name: `Thing ${m}-${i}`, qty: 1, weight: 5, slots: 1, where: "stowed" });
    p.members.push(pc);
  }
  const link = await partyLink(p, "https://example.test/");
  expect(link.length).toBeLessThan(8000);
  expect((await partyFromLink(new URL(link).hash))!.members).toHaveLength(6);
});
