import AxeBuilder from "@axe-core/playwright";
import { expect, remote, test } from "./fixtures";
// Translations in the desk: asking for one on a message, what is shown when none can be made, and
// the translation of a draft. No model is set up in the stack, so the worker and the routes answer
// that none can be made; the cases with a model are in the translation tests.
test.describe.configure({ mode: "serial" });
test("asks for a translation, shows why there is none, and translates a draft", async ({
  page,
  desk,
  signIn,
}) => {
  test.skip(
    remote,
    "The translation is made by a job, and a deployment takes jobs only when its schedule calls the worker.",
  );
  const { alpha } = desk.projects;
  await signIn();
  await page.goto(`/?ticket=${alpha.tickets[0]}`);
  const panel = page.getByRole("region", { name: "Ticket" });
  await panel.getByText("Translate", { exact: true }).first().click();
  const into = panel.getByRole("button", { name: /^Translate into/ }).first();
  await expect(into).toBeVisible();
  await into.click();
  // The worker finds no model and says so on the record; the source is untouched.
  // The worker takes the job within a few seconds, more when other tests keep it busy.
  await expect(panel.getByText(/No translation \(ai_not_configured\)/)).toBeVisible({
    timeout: 20_000,
  });
  await expect(panel.getByText(/Machine translation into/)).toBeVisible();
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  await panel.getByRole("button", { name: "Remove translations" }).click();
  await expect(panel.getByText(/No translation \(/)).toHaveCount(0);
  // A draft: the button needs text, and without a model the field is left as it was.
  const field = panel.getByRole("textbox", { name: "Write your reply in Markdown…" });
  const button = panel.getByRole("button", { name: /^Translate to/ });
  await expect(button).toBeDisabled();
  await field.fill(
    "Hallo, wir haben den Fehler gefunden und behoben. Bitte versuche es noch einmal.",
  );
  await expect(button).toBeEnabled();
  await button.click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(field).toHaveValue(
    "Hallo, wir haben den Fehler gefunden und behoben. Bitte versuche es noch einmal.",
  );
});
