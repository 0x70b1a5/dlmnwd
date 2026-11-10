// A party as a link. The party is packed into the part of the address after
// the `#`, which a browser never sends to a server. The link is a copy of the
// party as it was when the link was made: it does not follow later changes.

import { normalizeParty, type Party } from "../src/party/model.ts";

const MARK = "party=";
/** The most text a link may unpack to: far more than any real party. */
const MOST = 4_000_000;

async function through(
  bytes: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
  most = Infinity,
): Promise<Uint8Array<ArrayBuffer>> {
  const writer = stream.writable.getWriter();
  // A write to a stream with bad data fails here and at the reader; one report is enough.
  void writer.write(bytes).catch(() => {});
  void writer.close().catch(() => {});
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = stream.readable.getReader();
  for (;;) {
    // Each read needs the one before it.
    // oxlint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > most) throw new Error("too large");
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** A link to `page` that holds the party. */
export async function partyLink(party: Party, page: string): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(party));
  const packed = await through(json, new CompressionStream("deflate-raw"));
  return `${page.replace(/#.*$/, "")}#${MARK}${toBase64Url(packed)}`;
}

/** The party a link holds, or null when the address holds none. Throws when
 *  the address has a party that can't be read. */
export async function partyFromLink(hash: string): Promise<Party | null> {
  const at = hash.indexOf(MARK);
  if (at < 0) return null;
  const text = hash.slice(at + MARK.length).split("&")[0];
  let raw: unknown;
  try {
    const json = await through(fromBase64Url(text), new DecompressionStream("deflate-raw"), MOST);
    raw = JSON.parse(new TextDecoder().decode(json));
  } catch {
    throw new Error("The party in this link can't be read. The link may be cut short.");
  }
  return normalizeParty(raw, "The link");
}
