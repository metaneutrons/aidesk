import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, fixture, test } from "./fixtures";
// "Your sign-in" in the settings: the ways to sign in that the account has, and the open sessions. A second session is
// made by the fixture, as a sign-in from another browser would; the session of the test is marked and cannot be ended
// from here, the other one can.
test.describe.configure({ mode: "serial" });
const signInSchema = z.object({
  password: z.boolean(),
  codes: z.boolean(),
  passkeys: z.number(),
  providers: z.array(z.string()),
});
const sessionsSchema = z.object({
  sessions: z.array(
    z.object({ id: z.string(), current: z.boolean(), userAgent: z.string().nullable() }),
  ),
});
test("shows how the account signs in and ends another session", async ({
  page,
  desk,
  signIn,
  baseURL,
}) => {
  await signIn();
  // The sessions of the tests that ran before in this run are still open; start from this one alone.
  await page.request.post("/api/v1/me/sessions/end-others", {
    headers: { origin: baseURL ?? "" },
    data: {},
  });
  const added = z.object({ id: z.string() }).parse(JSON.parse(fixture("add-session", desk.email)));
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.locator("section.sign-in");
  await expect(section.getByRole("heading", { name: "Your sign-in" })).toBeVisible();
  // The fixture operator is an owner with a password and an authenticator app.
  const methods = section.getByRole("list", { name: "Ways to sign in" });
  await expect(methods).toContainText("With a password");
  await expect(methods).toContainText("With an authenticator app and backup codes");
  expect(
    signInSchema.parse(await (await page.request.get("/api/v1/me/sign-in")).json()),
  ).toMatchObject({
    password: true,
    codes: true,
  });
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  // This session is marked and has no button to end it; the other one has.
  const list = section.getByRole("list", { name: "Open sessions" });
  await expect(
    list.getByRole("listitem").filter({ has: page.getByText("This session", { exact: true }) }),
  ).toHaveCount(1);
  await expect(
    list
      .getByRole("listitem")
      .filter({ has: page.getByText("This session", { exact: true }) })
      .getByRole("button"),
  ).toHaveCount(0);
  const other = list.getByRole("listitem").filter({ hasText: "E2E Other Browser" });
  await expect(other).toContainText("192.0.2.44");
  // The API refuses to end the session that asks.
  const current = sessionsSchema
    .parse(await (await page.request.get("/api/v1/me/sessions")).json())
    .sessions.find((entry) => entry.current);
  expect(current).toBeDefined();
  const refused = await page.request.post(`/api/v1/me/sessions/${current?.id ?? ""}/end`, {
    headers: { origin: baseURL ?? "" },
    data: {},
  });
  expect(refused.status()).toBe(409);
  await other.getByRole("button", { name: /End this session/ }).click();
  await expect(section.getByText("The session was ended.")).toBeVisible();
  await expect(other).toHaveCount(0);
  expect(
    sessionsSchema
      .parse(await (await page.request.get("/api/v1/me/sessions")).json())
      .sessions.some((entry) => entry.id === added.id),
  ).toBe(false);
  // With no other session the button is off; with two, it ends both and keeps this one.
  const everything = section.getByRole("button", { name: "End all other sessions" });
  await expect(everything).toBeDisabled();
  fixture("add-session", desk.email);
  fixture("add-session", desk.email);
  await page.reload();
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  await expect(list.getByRole("listitem").filter({ hasText: "E2E Other Browser" })).toHaveCount(2);
  await everything.click();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(
    list.getByRole("listitem").first().getByText("This session", { exact: true }),
  ).toBeVisible();
  // The person is still signed in.
  await page.reload();
  await expect(page.getByRole("navigation")).toBeVisible();
});
