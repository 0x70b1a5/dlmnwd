import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Book } from "../web/book.ts";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

test("the dock starts closed, and its button opens and closes it", async () => {
  const { mountTable } = await import("../web/table.ts");
  const root = document.createElement("div");
  const { dock } = mountTable(root);
  document.body.append(root, dock);
  const toggle = dock.querySelector<HTMLElement>(".dock__toggle")!;
  expect(dock.hasAttribute("data-open")).toBe(false);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-label")).toBe("Show the dice");
  toggle.click();
  expect(dock.hasAttribute("data-open")).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.getAttribute("aria-label")).toBe("Hide the dice");
  toggle.click();
  expect(dock.hasAttribute("data-open")).toBe(false);
});

test("the lookup shows only while the tab has a book", async () => {
  const { mountTable } = await import("../web/table.ts");
  const root = document.createElement("div");
  const view = mountTable(root);
  const lookup = root.querySelector<HTMLElement>('[aria-label="Look up"]')!.closest("section")!;
  expect(lookup.hidden).toBe(true);
  view.setBook({ fileName: "book.pdf" } as Book);
  expect(lookup.hidden).toBe(false);
  view.setBook(null);
  expect(lookup.hidden).toBe(true);
});
