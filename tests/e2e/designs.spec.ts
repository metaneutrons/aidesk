import { z } from "zod";
import { expect, mailpit, test } from "./fixtures";
// Mail design settings: draft preview, versions, selection and the test mail
// that goes to the signed-in person.
test.describe.configure({ mode: "serial" });
const found = z.object({
  messages: z.array(z.object({ ID: z.string(), Subject: z.string() })),
});
test("previews a draft, saves a version, uses it and sends a test mail", async ({
  page,
  desk,
  signIn,
}) => {
  const header = `Design ${desk.run}`;
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.getByRole("region", { name: "Mail design" });
  await expect(section.getByText("Built-in design", { exact: true })).toBeVisible();
  await expect(section.getByText("In use", { exact: true })).toBeVisible();
  // A draft is previewed before it is saved.
  const form = section.locator("form");
  await form.getByLabel("Accent color").fill("#aa3355");
  await form.getByLabel("Header text").fill(header);
  await form.getByLabel("Footer (English)").fill("E2E footer text");
  await form.getByRole("button", { name: "Preview draft" }).click();
  const frame = section.frameLocator("iframe");
  await expect(frame.getByText(header)).toBeVisible();
  await expect(frame.getByText("E2E footer text")).toBeVisible();
  await expect(section.getByRole("heading", { name: /Preview: Draft/ })).toBeVisible();
  // Saved as a version, then selected.
  await form.getByRole("button", { name: "Save as new version" }).click();
  await expect(section.getByText("Version 1", { exact: true })).toBeVisible();
  await section.getByRole("button", { name: "Use: Version 1" }).click();
  await expect(section.getByText("In use", { exact: true })).toBeVisible();
  await expect(section.getByRole("button", { name: "Use: Version 1" })).toHaveCount(0);
  await section.getByRole("button", { name: "Show: Version 1" }).click();
  await expect(frame.getByText(header)).toBeVisible();
  try {
    await section.getByRole("button", { name: "Send test mail: Version 1" }).click();
    await expect(section.getByText("Test mail sent to your address")).toBeVisible({
      timeout: 45_000,
    });
    const subject = `[Test] ${desk.projects.alpha.name}, design version 1`;
    let id = "";
    await expect
      .poll(
        async () => {
          id =
            found
              .parse(
                await (
                  await page.request.get(
                    `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${desk.email}`)}`,
                  )
                ).json(),
              )
              .messages.find((message) => message.Subject === subject)?.ID ?? "";
          return id;
        },
        { timeout: 45_000, intervals: [1000] },
      )
      .not.toBe("");
    const message = z
      .object({ HTML: z.string(), Text: z.string() })
      .parse(await (await page.request.get(`${mailpit}/api/v1/message/${id}`)).json());
    expect(message.HTML).toContain("#aa3355");
    expect(message.HTML).toContain(header);
    expect(message.Text).toContain("E2E footer text");
  } finally {
    // The built-in design again, so other tests see the default.
    await section.getByRole("button", { name: "Use: Built-in design" }).click();
  }
});
