// The shop over a generated character's sheet: buy starting gear with the
// starting coins, from the saved book's price lists. Shown only for a
// character made with "Buy with starting gold". Pure DOM over gen/shop.ts.

import { type Character, coinsLeft, purseCp } from "../src/gen/character.ts";
import { buy, forSale, giveBack, priceOf, priceText } from "../src/gen/shop.ts";
import type { CatalogItem } from "../src/parse/gear.ts";
import { morph, on } from "./morph.ts";
import { h } from "./sheet.ts";
import { button } from "./ui.ts";

export interface ShopView {
  /** Open the shop for a character who buys gear; any other closes it. */
  show(c: Character | null, catalog: CatalogItem[]): void;
}

/** What a buyer wants to know about an entry besides its price. */
function detail(i: CatalogItem): string {
  const parts = [
    i.damage ? `damage ${i.damage}` : "",
    i.ac ? `AC ${i.ac}` : "",
    i.qualities ?? "",
    i.weight ? `weight ${i.weight}` : "",
  ];
  return parts.filter(Boolean).join(", ");
}

const title = (section: string): string =>
  section.charAt(0).toUpperCase() + section.slice(1).toLowerCase();

export function mountShop(root: HTMLElement, onChange: (c: Character) => void): ShopView {
  let character: Character | null = null;
  let catalog: CatalogItem[] = [];
  let said = "";
  const open = new Set<string>();

  function act(change: () => void): void {
    if (!character) return;
    try {
      change();
      said = "";
    } catch (err) {
      said = (err as Error).message;
    }
    draw();
    onChange(character);
  }

  function row(c: Character, item: CatalogItem): HTMLElement {
    const price = priceOf(item.cost)!;
    const b = button("Buy", () => act(() => buy(c, item, catalog)), "btn ghost", "button");
    b.setAttribute("aria-label", `Buy ${item.name}`);
    if (price.cp > purseCp(c)) b.setAttribute("disabled", "");
    return h(
      "li",
      { class: "shop__row" },
      h("span", { class: "shop__name" }, item.name),
      h("span", { class: "shop__detail" }, detail(item)),
      h("span", { class: "shop__price" }, priceText(price)),
      b,
    );
  }

  function draw(): void {
    const c = character;
    root.hidden = !c;
    if (!c) {
      root.replaceChildren();
      return;
    }
    const items = forSale(catalog);
    const sections = [...new Set(items.map((i) => i.section))];
    const bought = c.bought ?? [];
    const next = h(
      "div",
      {},
      h(
        "div",
        { class: "shop__head" },
        h("h2", {}, "Buy gear"),
        h("p", { class: "shop__purse", role: "status" }, `${coinsLeft(c)} left`),
      ),
      h(
        "p",
        { class: "hint" },
        `${c.klass.name}: armour ${c.klass.armour.toLowerCase()}; weapons ${c.klass.weapons.toLowerCase()}. `,
        "The trinket is rolled. Buy here, then add the character to the party.",
      ),
      items.length === 0
        ? h("p", { class: "hint" }, "The saved book has no price lists. Load the PDF again.")
        : null,
      bought.length
        ? h(
            "ul",
            { class: "shop__bought", "aria-label": "Bought" },
            ...bought.map((b) =>
              h(
                "li",
                {},
                b.qty > 1 ? `${b.name} ×${b.qty}` : b.name,
                button(
                  "−",
                  () => act(() => giveBack(c, b.name, catalog)),
                  "btn ghost shop__back",
                  "button",
                  `Give back ${b.name}`,
                ),
              ),
            ),
          )
        : h("p", { class: "shop__none" }, "Nothing bought yet."),
      said ? h("p", { class: "status", "data-kind": "error", role: "alert" }, said) : null,
      ...sections.map((s) => {
        const fold = h(
          "details",
          { class: "fold shop__section", "data-key": s, ...(open.has(s) ? { open: "" } : {}) },
          h("summary", {}, title(s)),
          open.has(s)
            ? h(
                "ul",
                { class: "shop__list" },
                ...items.filter((i) => i.section === s).map((i) => row(c, i)),
              )
            : null,
        );
        on(fold, "toggle", (e) => {
          const d = e.currentTarget as HTMLDetailsElement;
          const was = open.has(s);
          if (d.open) open.add(s);
          else open.delete(s);
          if (was !== d.open) draw();
        });
        return fold;
      }),
    );
    morph(root, next);
  }

  return {
    show(c, cat) {
      character = c?.bought ? c : null;
      catalog = cat;
      said = "";
      draw();
    },
  };
}
