// Small form helpers the Party and Table views share. Pure DOM.

import { on } from "./morph.ts";
import { h } from "./sheet.ts";

export function block(title: string, body: HTMLElement, size: "wide" | "" = ""): HTMLElement {
  return h(
    "section",
    { class: `member__block${size ? ` member__block--${size}` : ""}` },
    h("h3", {}, title),
    body,
  );
}

export function button(
  label: string,
  onClick: (() => void) | null,
  cls = "btn ghost",
  type: "button" | "submit" = "button",
  ariaLabel?: string,
): HTMLElement {
  const b = h(
    "button",
    { type, class: cls, ...(ariaLabel ? { "aria-label": ariaLabel } : {}) },
    label,
  );
  if (onClick) on(b, "click", onClick);
  return b;
}

export function form(onSubmit: () => void, ...kids: (HTMLElement | null)[]): HTMLElement {
  const f = h("form", { class: "row" }, ...kids);
  on(f, "submit", (e) => {
    e.preventDefault();
    onSubmit();
  });
  return f;
}

export function numInput(
  value: string,
  attrs: Record<string, string>,
  onChange?: (v: number) => void,
): HTMLInputElement {
  const el = h("input", {
    type: "number",
    inputmode: "numeric",
    step: "1",
    value,
    ...attrs,
  }) as HTMLInputElement;
  if (onChange)
    on(el, "change", () => {
      const v = parseInt(el.value, 10);
      if (Number.isFinite(v)) afterFocusMoves(() => onChange(v));
    });
  return el;
}

export function textInput(value: string, onChange: (v: string) => void): HTMLInputElement {
  const el = h("input", { type: "text", value }) as HTMLInputElement;
  on(el, "change", () => afterFocusMoves(() => onChange(el.value)));
  return el;
}

export function select(
  options: [string, string][],
  value: string,
  onChange?: (v: string) => void,
): HTMLSelectElement {
  const el = h(
    "select",
    {},
    ...options.map(([v, label]) =>
      h("option", v === value ? { value: v, selected: "" } : { value: v }, label),
    ),
  ) as HTMLSelectElement;
  // The test DOM does not always read the selected attribute: set the value too.
  el.value = value;
  if (onChange) on(el, "change", () => afterFocusMoves(() => onChange(el.value)));
  return el;
}

/**
 * Run a change from a field's change event once the browser has moved focus. A
 * field fires change as Tab leaves it; redrawing at once would replace the
 * control Tab is about to move to, and focus would fall to the page.
 */
export function afterFocusMoves(run: () => void): void {
  setTimeout(run, 0);
}
