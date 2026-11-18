// The choice between two copies of the party: this browser's and the one kept
// on the account, when both changed since they last matched. A dialog with both
// sides' members, when each was last changed, and what differs. Pure DOM.

import { type MemberDiff, partyDiff } from "../src/party/diff.ts";
import type { Party, PC } from "../src/party/model.ts";
import { h } from "./sheet.ts";

export type Choice = "mine" | "theirs" | "later";

export interface ConflictInfo {
  /** When each copy last changed (ms since 1970); null when not known. */
  mineAt: number | null;
  theirsAt: number | null;
  /** "Elf Enchanter 3" for a member, from the book's names. */
  describe(pc: PC): string;
}

function when(ms: number | null | undefined): string {
  if (!ms) return "not recorded";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

function side(title: string, p: Party, at: number | null, info: ConflictInfo): HTMLElement {
  return h(
    "section",
    { class: "conflict__side" },
    h("h3", {}, title),
    h(
      "p",
      { class: "conflict__when" },
      `Changed ${when(at)} · ${plural(p.members.length, "member")}`,
    ),
    p.members.length
      ? h(
          "ul",
          {},
          ...p.members.map((m) =>
            h(
              "li",
              {},
              h("span", { class: "conflict__name" }, m.name),
              h("span", { class: "conflict__what" }, info.describe(m)),
              h("span", { class: "conflict__when" }, `last change ${when(m.updated)}`),
            ),
          ),
        )
      : h("p", { class: "conflict__when" }, "No members."),
  );
}

function diffRow(d: MemberDiff): HTMLElement {
  const tag = {
    here: "only in this browser",
    there: "only on the account",
    changed: "",
    same: "",
  }[d.kind];
  return h(
    "li",
    { class: `conflict__diff conflict__diff--${d.kind}` },
    h("span", { class: "conflict__name" }, d.name),
    tag ? h("span", { class: "tag" }, tag) : null,
    d.changes.length ? h("ul", {}, ...d.changes.map((c) => h("li", {}, c))) : null,
  );
}

/** Ask which copy to keep. Resolves when the user chooses; Escape is "later". */
export function chooseParty(mine: Party, theirs: Party, info: ConflictInfo): Promise<Choice> {
  const diff = partyDiff(mine, theirs);
  const differs = diff.members.filter((d) => d.kind !== "same");
  const same = diff.members.length - differs.length;
  const dialog = h("dialog", {
    class: "conflict",
    "aria-labelledby": "conflict-title",
  }) as HTMLDialogElement;
  const btn = (label: string, choice: Choice, cls: string) => {
    const b = h("button", { type: "button", class: cls, "data-choice": choice }, label);
    b.addEventListener("click", () => finish(choice));
    return b;
  };
  const parts: (HTMLElement | null)[] = [
    h("h2", { id: "conflict-title", tabindex: "-1", autofocus: "" }, "Two versions of your party"),
    h(
      "p",
      { class: "sub" },
      "This browser and your account both changed the party since they last matched. Keep one; it replaces the other.",
    ),
    h(
      "div",
      { class: "conflict__sides" },
      side("This browser", mine, info.mineAt, info),
      side("Your account", theirs, info.theirsAt, info),
    ),
    h("h3", {}, "What differs (this browser → account)"),
    diff.party.length
      ? h("ul", { class: "conflict__party" }, ...diff.party.map((l) => h("li", {}, l)))
      : null,
    differs.length
      ? h("ul", { class: "conflict__diffs" }, ...differs.map(diffRow))
      : diff.party.length
        ? null
        : h("p", { class: "sub" }, "The members are the same."),
    same > 0 && differs.length
      ? h("p", { class: "sub" }, `${plural(same, "other member")} the same in both.`)
      : null,
    h(
      "div",
      { class: "conflict__go" },
      btn("Keep this browser's", "mine", "btn"),
      btn("Use the account's", "theirs", "btn"),
      btn("Decide later", "later", "btn ghost"),
    ),
    h(
      "p",
      { class: "hint" },
      "Using the account's party can be undone in the Party tab. Keeping this browser's replaces the account's copy for good.",
    ),
  ];
  dialog.append(...parts.filter((p): p is HTMLElement => p !== null));
  const { promise: done, resolve } = Promise.withResolvers<Choice>();
  function finish(c: Choice): void {
    if (dialog.open) dialog.close();
    dialog.remove();
    resolve(c);
  }
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    finish("later");
  });
  document.body.append(dialog);
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  // Open at the top, on the heading, not scrolled down to the first button.
  dialog.querySelector<HTMLElement>("#conflict-title")?.focus();
  dialog.scrollTop = 0;
  return done;
}
