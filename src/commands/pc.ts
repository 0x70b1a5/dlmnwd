import { writeFileSync } from "node:fs";
import {
  allowedCount,
  applyCoins,
  applyHp,
  coinSpec,
  findRune,
  forgetName,
  gainsRunesOnLevel,
  learnName,
  moveCoins,
  setField,
} from "../party/actions.ts";
import { describeLoad, type Load } from "../party/encumbrance.ts";
import { addItem, findItem, makeItem, removeItem, slotCost } from "../party/items.ts";
import { firstName } from "../party/import.ts";
import { formatCoins, loadOf, pcMarkdown, showParty, showPc } from "../party/render.ts";
import { classOf, type PartyRules } from "../party/rules.ts";
import { grantRune, lookupRune, rollRuneGrant, runeStatus, useRune } from "../party/runes.ts";
import {
  castSpell,
  clearSpell,
  isCaster,
  preparable,
  prepareSpell,
  slotUse,
  traditionSpells,
} from "../party/spells.ts";
import { findMember, type Party, type PC, saveParty, type Where } from "../party/store.ts";
import { canLevel, grantXp, levelUp, nextLevelXp } from "../party/xp.ts";
import { partyContext } from "./party.ts";

const USAGE = `usage: dw pc <name> [command]      (name: any unambiguous part of it)
  (none)                         the character: stats, load and Speed, gear, magic
  item add <item> [qty]          add gear, looked up in the book's equipment lists
                                   (-e/--equipped, -s/--stowed, --weight=N, --slots=N,
                                   --treasure, --as="Label" to keep your own name)
  item rm <item> [qty]           drop some or all of an item
  item set <item> k=v…           weight=, slots=, qty=, name=, note=, treasure=yes|no
  equip <item> / stow <item>     move an item between equipped and stowed
  coins <±N(cp|sp|gp|pp)>…       e.g. coins +120gp -3sp   (=N sets)
  bank <N(cp|sp|gp|pp)>…         move carried coins to the bank   (withdraw: back)
  hp <±N | =N | max>             damage, heal, set, or restore to full
  xp <±N> [--raw]                add XP (through the XP modifier unless --raw)
  levelup [--hp=N] [--force]     take the next level: HP, Attack, Saves (--hp: your roll)
  glamour add|rm <name>          (add --random rolls one not yet known)
  rune add|rm <name>             a duplicate grant doubles its uses
  rune use <name> [--force]      spend a use; limits follow magnitude and level
  rune learn [--mod=N]           roll 2d6 + level bonus on the rune-granted table
  knack add|rm <name>
  spell                          spell slots by Rank, and the spells ready or cast
  spell add|rm <name>            a spell the character knows (a spell book)
  prepare <spell> [--force]      put a spell in a slot of its Rank for the day
  cast <spell>                   cast a prepared spell (dw party rest brings it back)
  spell clear <spell>|all        take a spell out of its slot
  note add <text> | note rm <n>
  set k=v…                       name=, player=, alignment=, background=, moon_sign=,
                                   affiliation=, kindred=, class=, level=, ac_bonus=,
                                   retainer=yes|no, status=active|retired|dead,
                                   str= int= wis= dex= con= cha=
  sheet [--out=file.md]          a vault Markdown sheet`;

function positional(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("-") || /^-\d/.test(a));
}

function flag(args: string[], key: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`${key}=`));
  return hit ? hit.slice(key.length + 1) : undefined;
}

function yes(v: string): boolean {
  return /^(y|yes|true|1|on)$/i.test(v);
}

/** Print the load after a change, calling out a Speed change and any limit broken. */
function reportLoad(pc: PC, party: Party, rules: PartyRules, before?: Load): void {
  const load = loadOf(pc, party, rules);
  const change =
    before && before.speed !== load.speed ? `  (Speed ${before.speed} → ${load.speed})` : "";
  console.log(`  Load: ${describeLoad(load)}${change}`);
  for (const p of load.problems) console.log(`  ⚠ ${p}`);
}

export function cmdPc(args: string[]): void {
  const pos = positional(args);
  if (pos.length === 0 || pos[0] === "help" || args.includes("--help")) {
    if (pos.length === 0 && !args.includes("--help")) {
      const { party, rules } = partyContext();
      console.log(showParty(party, rules));
      console.log("");
    }
    console.log(USAGE);
    return;
  }
  const { party, rules } = partyContext();
  const pc = findMember(party, pos[0]);
  const [verb, ...rest] = pos.slice(1);
  const save = () => saveParty(party);

  switch (verb) {
    case undefined:
    case "show":
      console.log(showPc(pc, party, rules));
      return;

    case "sheet": {
      const md = pcMarkdown(pc, party, rules);
      const out = flag(args, "--out");
      if (out) {
        writeFileSync(out, md);
        console.error(`Wrote ${pc.name} to ${out}`);
      } else process.stdout.write(md);
      return;
    }

    case "item":
    case "items":
      return itemCmd(pc, party, rules, rest, args);

    case "equip":
    case "stow": {
      const before = loadOf(pc, party, rules);
      const inv = findItem(pc, rest.join(" "));
      const where: Where = verb === "equip" ? "equipped" : "stowed";
      if (where === "stowed" && inv.bulky)
        console.log(`  ⚠ ${inv.name} is bulky: it takes two hands and can't be stowed.`);
      inv.where = where;
      save();
      console.log(`${pc.name}: ${inv.name} → ${where}`);
      reportLoad(pc, party, rules, before);
      return;
    }

    case "coins":
    case "coin":
    case "gold": {
      const before = loadOf(pc, party, rules);
      if (rest.length === 0) {
        console.log(`${pc.name}: ${formatCoins(pc.coins)}  (banked ${formatCoins(pc.banked)})`);
        return;
      }
      for (const spec of rest) applyCoins(pc.coins, spec);
      save();
      console.log(`${pc.name}: ${formatCoins(pc.coins)}`);
      reportLoad(pc, party, rules, before);
      return;
    }

    case "bank":
    case "withdraw": {
      const before = loadOf(pc, party, rules);
      const [from, to] = verb === "bank" ? [pc.coins, pc.banked] : [pc.banked, pc.coins];
      for (const spec of rest) {
        const { kind, n } = coinSpec(spec.replace(/^[+=]/, ""));
        moveCoins(from, to, kind, n, pc.name);
      }
      save();
      console.log(
        `${pc.name}: carrying ${formatCoins(pc.coins)}; banked ${formatCoins(pc.banked)}`,
      );
      reportLoad(pc, party, rules, before);
      return;
    }

    case "hp": {
      applyHp(pc, rest[0] ?? "");
      save();
      const state = pc.hp <= 0 ? "  ⚠ at 0 HP or below" : "";
      console.log(`${pc.name}: HP ${pc.hp}/${pc.maxHp}${state}`);
      return;
    }

    case "xp": {
      const n = parseInt(rest[0] ?? "", 10);
      if (!Number.isFinite(n)) throw new Error("usage: dw pc <name> xp <±N> [--raw]");
      let line: string;
      if (args.includes("--raw") || n < 0) {
        pc.xp = Math.max(0, pc.xp + n);
        line = `${n >= 0 ? "+" : ""}${n}`;
      } else {
        const a = grantXp(pc, n, rules);
        line = `+${a.gained}${a.modifier ? ` (${a.modifier > 0 ? "+" : ""}${a.modifier}%)` : ""}`;
      }
      save();
      const klass = classOf(rules, pc.class);
      const next = nextLevelXp(pc, klass);
      const ready = canLevel(pc, klass)
        ? `  ★ can reach level ${pc.level + 1}: dw pc ${firstName(pc)} levelup`
        : "";
      console.log(
        `${pc.name}: ${line} → ${pc.xp.toLocaleString()} XP${next !== null ? ` (next level ${next.toLocaleString()})` : ""}${ready}`,
      );
      return;
    }

    case "levelup":
    case "level": {
      const klass = classOf(rules, pc.class);
      if (!klass?.advancement?.length)
        throw new Error(
          `No advancement table for "${pc.class || "?"}" (configure the Player's Book, or set class=).`,
        );
      if (!canLevel(pc, klass) && !args.includes("--force")) {
        const next = nextLevelXp(pc, klass);
        throw new Error(
          next === null
            ? `${pc.name} is at the top of the ${klass.name} table.`
            : `${pc.name} has ${pc.xp.toLocaleString()} XP; level ${pc.level + 1} needs ${next.toLocaleString()} (--force to level anyway).`,
        );
      }
      const hpFlag = flag(args, "--hp");
      const up = levelUp(pc, klass, hpFlag ? { hp: parseInt(hpFlag, 10) } : {});
      save(); // a rune limited to once per Level is usable again from here
      console.log(`${pc.name} reaches level ${up.to}!`);
      console.log(`  HP +${up.hpGained} [${up.hpRoll}] → ${pc.hp}/${pc.maxHp}`);
      if (up.attack[0] !== up.attack[1]) console.log(`  Attack ${up.attack[0]} → +${up.attack[1]}`);
      const saves = (Object.keys(up.saves[1]) as (keyof PC["saves"])[]).filter(
        (k) => up.saves[0][k] !== up.saves[1][k],
      );
      if (saves.length)
        console.log(
          `  Saves ${saves.map((k) => `${k} ${up.saves[0][k]} → ${up.saves[1][k]}`).join(", ")}`,
        );
      for (const [k, [a, b]] of Object.entries(up.extras)) {
        console.log(`  ${k} ${a || "–"} → ${b}`);
        if (/glamour/i.test(k)) {
          const want = parseInt(b, 10) - pc.glamours.length;
          if (want > 0)
            console.log(
              `    ${pc.name} knows ${pc.glamours.length}; add ${want}: dw pc ${firstName(pc)} glamour add <name> (or --random)`,
            );
        }
      }
      if (gainsRunesOnLevel(pc, rules))
        console.log(`  Roll for a new rune: dw pc ${firstName(pc)} rune learn`);
      const next = nextLevelXp(pc, klass);
      if (next !== null) console.log(`  Next level at ${next.toLocaleString()} XP`);
      console.log(
        `  Check the ${klass.name} entry for new spells, skills, and traits at this level.`,
      );
      return;
    }

    case "glamour":
    case "glamours":
      return listCmd(pc, party, rules, "glamours", rules.glamours, rest, args);
    case "knack":
    case "knacks":
      return listCmd(pc, party, rules, "knacks", rules.knacks, rest, args);
    case "spell":
    case "spells":
      return spellCmd(pc, party, rules, rest, args);
    case "prepare":
    case "cast":
      return spellCmd(pc, party, rules, [verb, ...rest], args);

    case "rune":
    case "runes":
      return runeCmd(pc, party, rules, rest, args);

    case "note":
    case "notes": {
      const [op, ...text] = rest;
      if (op === "add") pc.notes.push(text.join(" "));
      else if (op === "rm") {
        const n = parseInt(text[0] ?? "", 10);
        if (!(n >= 1 && n <= pc.notes.length))
          throw new Error(`usage: dw pc <name> note rm <1-${pc.notes.length}>`);
        pc.notes.splice(n - 1, 1);
      } else {
        pc.notes.forEach((n, k) => console.log(`${k + 1}. ${n}`));
        return;
      }
      save();
      pc.notes.forEach((n, k) => console.log(`${k + 1}. ${n}`));
      return;
    }

    case "set": {
      for (const kv of rest) setField(pc, rules, kv);
      save();
      console.log(showPc(pc, party, rules));
      return;
    }

    default:
      throw new Error(`Unknown pc command "${verb}".\n\n${USAGE}`);
  }
}

function itemCmd(pc: PC, party: Party, rules: PartyRules, rest: string[], args: string[]): void {
  const [op, ...words] = rest;
  const before = loadOf(pc, party, rules);
  switch (op) {
    case undefined:
    case "list": {
      console.log(showPc(pc, party, rules));
      return;
    }
    case "add": {
      // A trailing bare number is the quantity: "item add torches 2".
      let qty: number | undefined;
      if (words.length > 1 && /^\d+$/.test(words.at(-1)!)) qty = parseInt(words.pop()!, 10);
      const text = words.join(" ");
      if (!text) throw new Error("usage: dw pc <name> item add <item> [qty]");
      const where: Where | undefined =
        args.includes("-e") || args.includes("--equipped")
          ? "equipped"
          : args.includes("-s") || args.includes("--stowed")
            ? "stowed"
            : undefined;
      const w = flag(args, "--weight");
      const sl = flag(args, "--slots");
      const label = flag(args, "--as");
      const { inv, resolved } = makeItem(rules.catalog, rules.enc, text, {
        qty,
        where,
        weight: w !== undefined ? parseInt(w, 10) : undefined,
        slots: sl !== undefined ? parseInt(sl, 10) : undefined,
        treasure: args.includes("--treasure") ? true : undefined,
      });
      if (label) inv.name = label;
      const stacked = addItem(pc, inv);
      saveParty(party);
      const found = resolved.item
        ? `${resolved.item.name}: ${inv.weight} coins${inv.qty > 1 ? " each" : ""}, ${inv.slots} slot${inv.slots === 1 ? "" : "s"}`
        : `not in the book's lists: weight ${inv.weight} (set with --weight=N)`;
      console.log(
        `${pc.name} +${inv.qty} ${inv.name} → ${inv.where}  [${found}]` +
          (stacked.qty !== inv.qty ? `  (now ×${stacked.qty})` : ""),
      );
      reportLoad(pc, party, rules, before);
      return;
    }
    case "rm":
    case "remove":
    case "drop":
    case "use": {
      let qty: number | undefined;
      if (words.length > 1 && /^\d+$/.test(words.at(-1)!)) qty = parseInt(words.pop()!, 10);
      const inv = findItem(pc, words.join(" "));
      const n = removeItem(pc, inv, qty);
      saveParty(party);
      const left = pc.items.includes(inv) ? ` (${inv.qty} left)` : "";
      console.log(`${pc.name} −${n} ${inv.name}${left}`);
      reportLoad(pc, party, rules, before);
      return;
    }
    case "set": {
      const kvs = words.filter((w) => /^[a-z_]+=/.test(w));
      const inv = findItem(pc, words.filter((w) => !kvs.includes(w)).join(" "));
      for (const kv of kvs) {
        const [k, ...v] = kv.split("=");
        const val = v.join("=");
        if (k === "weight") inv.weight = parseInt(val, 10);
        else if (k === "slots") inv.slots = parseInt(val, 10);
        else if (k === "qty") inv.qty = parseInt(val, 10);
        else if (k === "name") inv.name = val;
        else if (k === "note") inv.note = val || undefined;
        else if (k === "treasure") inv.treasure = yes(val);
        else if (k === "where") inv.where = val === "equipped" ? "equipped" : "stowed";
        else if (k === "ref") {
          const { item } = makeItem(rules.catalog, rules.enc, val).resolved;
          if (!item) throw new Error(`"${val}" isn't in the book's equipment lists.`);
          inv.ref = item.name;
          inv.weight = item.weight;
          inv.slots = slotCost(item, item.name, rules.enc);
        } else throw new Error(`Unknown item field "${k}".`);
      }
      if (pc.items.includes(inv) && inv.qty <= 0) pc.items = pc.items.filter((i) => i !== inv);
      saveParty(party);
      console.log(
        `${pc.name}: ${inv.name} ×${inv.qty}, ${inv.weight} coins, ${inv.slots} slots, ${inv.where}`,
      );
      reportLoad(pc, party, rules, before);
      return;
    }
    default:
      throw new Error(`Unknown item command "${op}" (add, rm, set).`);
  }
}

/** Add/remove a name on one of the PC's magic lists, matched to the book's names. */
function listCmd(
  pc: PC,
  party: Party,
  rules: PartyRules,
  field: "glamours" | "knacks" | "spells",
  known: string[],
  rest: string[],
  args: string[],
): void {
  const [op, ...words] = rest;
  const name = words.join(" ").trim();
  const list = pc[field];
  if (op === "add") {
    const chosen = learnName(pc, field, known, name, {
      random: args.includes("--random"),
      force: args.includes("--force"),
    });
    saveParty(party);
    console.log(`${pc.name} learns ${chosen}. ${cap(field)}: ${list.join(", ")}`);
    const allowed = allowedCount(pc, rules, field);
    if (allowed !== null && list.length > allowed)
      console.log(
        `  ⚠ ${classOf(rules, pc.class)!.name} level ${pc.level} knows ${allowed} ${field} by class (kindred ${field} may add more)`,
      );
    return;
  }
  if (op === "rm" || op === "remove") {
    const hit = forgetName(pc, field, name);
    saveParty(party);
    console.log(`${pc.name} forgets ${hit}. ${cap(field)}: ${pc[field].join(", ") || "none"}`);
    return;
  }
  console.log(`${cap(field)}: ${list.join(", ") || "none"}`);
  if (known.length) console.log(`(the book lists: ${known.join(", ")})`);
}

/** Spells: the known list, the day's slots, and what is ready or cast. */
function spellCmd(pc: PC, party: Party, rules: PartyRules, rest: string[], args: string[]): void {
  const [op, ...words] = rest;
  const name = words.join(" ").trim();
  const show = () => {
    for (const u of slotUse(pc, rules))
      console.log(`  Rank ${u.rank}: ${u.filled}/${u.slots} prepared, ${u.ready} ready`);
    for (const p of pc.prepared)
      console.log(`  ${p.cast ? "✗" : "●"} ${p.name}${p.cast ? " (cast)" : ""}`);
  };
  switch (op) {
    case "add":
    case "rm":
    case "remove": {
      const mine = traditionSpells(pc, rules);
      const known = (mine.length ? mine : rules.spells).map((s) => s.name);
      listCmd(pc, party, rules, "spells", known, rest, args);
      return;
    }
    case "prepare":
    case "ready": {
      const hit = prepareSpell(pc, rules, name, args.includes("--force"));
      saveParty(party);
      console.log(`${pc.name} prepares ${hit}.`);
      show();
      return;
    }
    case "cast": {
      const hit = castSpell(pc, name);
      saveParty(party);
      console.log(`${pc.name} casts ${hit}.`);
      show();
      return;
    }
    case "clear":
    case "unprepare": {
      if (name.toLowerCase() === "all") pc.prepared = [];
      else clearSpell(pc, name);
      saveParty(party);
      show();
      return;
    }
    case undefined:
    case "list": {
      console.log(`Spells: ${pc.spells.join(", ") || "none"}`);
      if (pc.prepared.length === 0 && slotUse(pc, rules).length === 0) {
        if (!isCaster(pc, rules)) console.log("  (this class has no spells-per-day table indexed)");
        return;
      }
      show();
      const can = preparable(pc, rules);
      if (can.length)
        console.log(
          `Can prepare: ${can.map((s) => (s.rank ? `${s.name} (${s.rank})` : s.name)).join(", ")}`,
        );
      return;
    }
    default:
      throw new Error("usage: dw pc <name> spell [add|rm|prepare|cast|clear <spell>]");
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function runeCmd(pc: PC, party: Party, rules: PartyRules, rest: string[], args: string[]): void {
  const [op, ...words] = rest;
  const name = words.join(" ").trim();
  const show = () => {
    if (pc.runes.length === 0) console.log(`${pc.name} knows no runes.`);
    for (const r of pc.runes) {
      const st = runeStatus(r, pc, party.day, rules.runes);
      const times = r.times > 1 ? ` ×${r.times}` : "";
      console.log(
        `  ${r.name} (${r.magnitude || "?"}; ${st.band?.text ?? "frequency unknown"}${times}` +
          `${st.left === null ? "" : `, ${st.left}/${st.limit} left`})`,
      );
    }
  };
  switch (op) {
    case undefined:
    case "list":
      show();
      return;
    case "add": {
      const entry = lookupRune(rules.runes, name);
      if (!entry) {
        if (!args.includes("--force"))
          throw new Error(`"${name}" isn't in the book's rune lists; --force to add it anyway.`);
        pc.runes.push({ name, magnitude: flag(args, "--magnitude") ?? "", times: 1, uses: [] });
        saveParty(party);
        console.log(`${pc.name} is granted ${name}.`);
        return;
      }
      const { rune, duplicate } = grantRune(pc, entry);
      saveParty(party);
      console.log(
        duplicate
          ? `${pc.name} is granted ${rune.name} again: its uses are doubled (×${rune.times}).`
          : `${pc.name} is granted ${rune.name} (${rune.magnitude}).`,
      );
      show();
      return;
    }
    case "rm":
    case "remove": {
      const hit = findRune(pc, name);
      pc.runes = pc.runes.filter((r) => r !== hit);
      saveParty(party);
      console.log(`${pc.name} loses ${hit.name}.`);
      return;
    }
    case "use":
    case "cast": {
      const hit = findRune(pc, name);
      const st = useRune(hit, pc, party.day, rules.runes, args.includes("--force"));
      saveParty(party);
      console.log(
        `${pc.name} uses ${hit.name}` +
          (st.left === null ? "." : `: ${st.left}/${st.limit} left (${st.band?.text}).`),
      );
      return;
    }
    case "learn":
    case "roll": {
      if (rules.runes.granted.length === 0)
        throw new Error("The rune-granted table isn't indexed (configure the Player's Book).");
      const mod = parseInt(flag(args, "--mod") ?? "0", 10) || 0;
      const g = rollRuneGrant(rules.runes, pc.level, mod);
      const bonus = g.bonus ? ` ${g.bonus > 0 ? "+" : "−"} ${Math.abs(g.bonus)}` : "";
      console.log(`${pc.name} rolls 2d6 ${g.dice}${bonus} = ${g.total}: ${g.text}`);
      if (!g.entry) return;
      const { rune, duplicate } = grantRune(pc, g.entry);
      saveParty(party);
      console.log(
        duplicate
          ? `  ${rune.name} — already known, so its uses are doubled (×${rune.times}).`
          : `  ${rune.name} (${rune.magnitude})`,
      );
      return;
    }
    default:
      throw new Error(`Unknown rune command "${op}" (add, rm, use, learn).`);
  }
}
