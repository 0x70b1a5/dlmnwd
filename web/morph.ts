// Change a drawn tree into a newly built one, in place. The elements that are
// the same stay in the page, so the scroll position, the focus on a button, an
// open fold and the text the user has selected are kept, and the browser lays
// out only what changed. Pure DOM.
//
// A view builds its whole tree again on each change, with new handlers that
// hold the new state. `on` keeps each element's handlers in a table, so a kept
// element can take the handlers of the element built in its place.
//
// A form control (input, select, textarea) is the exception: the new control
// goes into the page. A handler reads a field through the element it was built
// with (`input.value`), so that element must be the one in the page. The new
// control takes the focus, the selection and the text typed in the old one.
//
// Children are matched by position. Elements with different `data-key` values
// are never matched: the new one replaces the old one.

type Handler = (e: Event) => void;

const handlers = new WeakMap<EventTarget, Map<string, Handler>>();

function dispatch(e: Event): void {
  // The element the listener is on. Not `this`: the test DOM gives a select's
  // listeners another one.
  const el = e.currentTarget;
  if (el) handlers.get(el)?.get(e.type)?.(e);
}

/**
 * Listen for an event on an element a view builds. Use this in place of
 * addEventListener, so `morph` can move the handler to the element it keeps.
 * A handler must read the element from the event (`e.currentTarget`), not from
 * a variable, unless the element is a form control.
 */
export function on(el: EventTarget, type: string, fn: Handler): void {
  let mine = handlers.get(el);
  if (!mine) handlers.set(el, (mine = new Map()));
  mine.set(type, fn);
  el.addEventListener(type, dispatch);
}

const CONTROL = new Set(["INPUT", "SELECT", "TEXTAREA"]);
/** The input types that hold text the user types. */
const TYPED = new Set(["text", "number", "search", "tel", "url", "email", "password"]);

export interface MorphOptions {
  /** True for a field whose typed text must not be kept (its form was sent). */
  spent?(old: Element): boolean;
}

/** Make `old`'s children the same as `next`'s. `next` is used up. */
export function morph(old: Element, next: Element, opts: MorphOptions = {}): void {
  const olds = [...old.childNodes];
  const news = [...next.childNodes];
  news.forEach((n, i) => {
    const o = olds[i];
    if (!o) old.append(n);
    else if (!same(o, n)) old.replaceChild(n, o);
    else if (o.nodeType === Node.ELEMENT_NODE) {
      if (CONTROL.has(o.nodeName)) swapControl(o as HTMLElement, n as HTMLElement, opts);
      else {
        adopt(o as Element, n as Element);
        morph(o as Element, n as Element, opts);
      }
    } else if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue;
  });
  for (const o of olds.slice(news.length)) o.remove();
}

/** True when the kept node can become the new one: the same kind of node, and
 *  the same `data-key` when the elements have one. */
function same(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
  if (a.nodeType !== Node.ELEMENT_NODE) return true;
  return (a as Element).getAttribute("data-key") === (b as Element).getAttribute("data-key");
}

/** Give the kept element the attributes and handlers of the new one. */
function adopt(old: Element, next: Element): void {
  for (const name of old.getAttributeNames())
    if (!next.hasAttribute(name)) old.removeAttribute(name);
  for (const name of next.getAttributeNames()) {
    const v = next.getAttribute(name)!;
    if (old.getAttribute(name) !== v) old.setAttribute(name, v);
  }
  const mine = handlers.get(next);
  if (mine) {
    handlers.set(old, mine);
    for (const type of mine.keys()) old.addEventListener(type, dispatch);
  } else handlers.delete(old);
}

/** Put the new control in the page, with the state the user gave the old one. */
function swapControl(old: HTMLElement, next: HTMLElement, opts: MorphOptions): void {
  const focused = document.activeElement === old;
  if (isTyped(old) && isTyped(next)) {
    const typed = old.value !== old.defaultValue;
    if (typed && next.defaultValue === old.defaultValue && !opts.spent?.(old))
      next.value = old.value;
  }
  if (isCheck(old) && isCheck(next)) {
    const set = old.checked !== old.defaultChecked;
    if (set && next.defaultChecked === old.defaultChecked && !opts.spent?.(old))
      next.checked = old.checked;
  }
  let range: [number | null, number | null] | null = null;
  if (focused && isTyped(old)) {
    try {
      range = [old.selectionStart, old.selectionEnd];
    } catch {
      // A number field has no selection to read.
    }
  }
  old.replaceWith(next);
  if (!focused) return;
  next.focus({ preventScroll: true });
  if (range && range[0] !== null && isTyped(next)) {
    try {
      next.setSelectionRange(range[0], range[1]);
    } catch {
      // As above.
    }
  }
}

function isCheck(el: HTMLElement): el is HTMLInputElement {
  return el.nodeName === "INPUT" && (el as HTMLInputElement).type === "checkbox";
}

function isTyped(el: HTMLElement): el is HTMLInputElement {
  return (
    el.nodeName === "TEXTAREA" ||
    (el.nodeName === "INPUT" && TYPED.has((el as HTMLInputElement).type))
  );
}
