import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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
