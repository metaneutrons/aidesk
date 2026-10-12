import { afterEach, describe, expect, it, vi } from "vitest";
import { smtp2goSuppressed } from "../src/server/smtp2go";
function reply(status: number, body: unknown) {
  const fetch = vi.fn(() => Promise.resolve(Response.json(body, { status })));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("SMTP2GO suppression check", () => {
  it("reports a listed recipient and asks for exactly that address", async () => {
    const fetch = reply(200, {
      request_id: "r",
      data: {
        results: [{ email_address: "customer@example.test", reason: "unsubscribe" }],
        total_results: 1,
      },
    });
    expect(await smtp2goSuppressed("api-key", "customer@example.test")).toBe(true);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.smtp2go.com/v3/suppression/view");
    expect(new Headers(init.headers).get("x-smtp2go-api-key")).toBe("api-key");
    expect(JSON.parse(init.body as string)).toEqual({ email_address: "customer@example.test" });
  });
  it("lets an unlisted recipient through", async () => {
    reply(200, { request_id: "r", data: { results: [], total_results: 0 } });
    expect(await smtp2goSuppressed("api-key", "customer@example.test")).toBe(false);
  });
  it("fails closed when the list cannot be read", async () => {
    reply(401, { request_id: "r", data: { error: "invalid key" } });
    await expect(smtp2goSuppressed("api-key", "a@example.test")).rejects.toThrow(
      "suppression_check_failed",
    );
    reply(200, { request_id: "r", data: {} });
    await expect(smtp2goSuppressed("api-key", "a@example.test")).rejects.toThrow(
      "suppression_check_failed",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("network"))),
    );
    await expect(smtp2goSuppressed("api-key", "a@example.test")).rejects.toThrow(
      "suppression_check_failed",
    );
  });
});
