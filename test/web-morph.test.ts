import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { morph, on } from "../web/morph.ts";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

function tree(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

function mounted(html: string): HTMLElement {
  const el = tree(html);
  document.body.replaceChildren(el);
  return el;
}

test("an element that is the same stays, with new text and attributes", () => {
  const root = mounted('<p class="a" title="t">one</p><ul><li>x</li><li>y</li></ul>');
  const p = root.querySelector("p")!;
  const first = root.querySelector("li")!;
  morph(root, tree('<p class="b">two</p><ul><li>x</li></ul><span>new</span>'));
  expect(root.querySelector("p")).toBe(p);
  expect(root.querySelector("li")).toBe(first);
  expect(root.innerHTML).toBe('<p class="b">two</p><ul><li>x</li></ul><span>new</span>');
});

test("a kept element takes the handler of the element built in its place", () => {
  const said: string[] = [];
  const build = (word: string, listen = true): HTMLElement => {
    const el = tree("<button>go</button>");
    if (listen) on(el.firstElementChild!, "click", () => said.push(word));
    return el;
  };
  const root = build("first");
  document.body.replaceChildren(root);
  const button = root.querySelector("button")!;
  button.click();
  morph(root, build("second"));
  expect(root.querySelector("button")).toBe(button);
  button.click();
  morph(root, build("", false));
  button.click();
  expect(said).toEqual(["first", "second"]);
});

test("a different tag or data-key puts the new element in", () => {
  const root = mounted('<article data-key="a"><b>1</b></article>');
  const article = root.querySelector("article")!;
  morph(root, tree('<article data-key="a"><i>1</i></article>'));
  expect(root.querySelector("article")).toBe(article);
  expect(root.innerHTML).toBe('<article data-key="a"><i>1</i></article>');
  morph(root, tree('<article data-key="b"><i>1</i></article>'));
  expect(root.querySelector("article")).not.toBe(article);
});

test("the new field goes in, with the typed text and the focus of the old one", () => {
  const root = mounted('<input type="text" value="old"><input type="checkbox">');
  const [text, check] = [...root.querySelectorAll("input")];
  text.value = "typed";
  check.checked = true;
  text.focus();
  const next = tree('<input type="text" value="old"><input type="checkbox">');
  const built = next.querySelector("input")!;
  morph(root, next);
  expect(root.querySelector("input")).toBe(built);
  expect(built.value).toBe("typed");
  expect(document.activeElement).toBe(built);
  expect(root.querySelectorAll("input")[1].checked).toBe(true);
});

test("a new value from the view wins, and so does a spent field", () => {
  const root = mounted('<input type="text" value="5"><form><input type="text"></form>');
  const [a, b] = [...root.querySelectorAll("input")];
  a.value = "7";
  b.value = "sent";
  morph(root, tree('<input type="text" value="9"><form><input type="text"></form>'), {
    spent: (el) => !!el.closest("form"),
  });
  const [a2, b2] = [...root.querySelectorAll("input")];
  expect(a2.value).toBe("9");
  expect(b2.value).toBe("");
});
