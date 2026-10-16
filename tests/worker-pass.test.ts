import { afterEach, describe, expect, it, vi } from "vitest";
const budgets = vi.hoisted(() => [] as number[]);
vi.mock("../src/worker/pass", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/worker/pass")>();
  return {
    ...original,
    runBounded: (budget: number) => {
      budgets.push(budget);
      return Promise.resolve({ passes: 2, idle: true });
    },
  };
});
import { runBounded } from "../src/worker/pass";
import { GET, POST } from "../src/app/api/worker/tick/route";
const secret = "s".repeat(40);
const call = (method: "GET" | "POST", headers: Record<string, string> = {}, query = "") =>
  (method === "GET" ? GET : POST)(
    new Request(`http://localhost/api/worker/tick${query}`, { method, headers }),
  );
afterEach(() => {
  vi.unstubAllEnvs();
  budgets.length = 0;
});
describe("working the queue in passes that end", () => {
  // The original, not the mock, is under test here.
  const bounded = async (
    worked: boolean[],
    budgetMs: number,
    clock: number[],
  ): Promise<{ passes: number; idle: boolean; asked: number }> => {
    const real = await vi.importActual<typeof import("../src/worker/pass")>("../src/worker/pass");
    let asked = 0;
    let turn = 0;
    const result = await real.runBounded(
      budgetMs,
      () => {
        asked += 1;
        return Promise.resolve(worked[turn++] ?? false);
      },
      () => clock[Math.min(turn, clock.length - 1)] ?? 0,
    );
    return { ...result, asked };
  };
  it("stops at the first pass that finds nothing", async () => {
    expect(await bounded([true, true, false], 1000, [0])).toEqual({
      passes: 3,
      idle: true,
      asked: 3,
    });
    expect(await bounded([false], 1000, [0])).toEqual({ passes: 1, idle: true, asked: 1 });
  });
  it("stops when the time is up, after the pass that was running, and not before", async () => {
    // The clock is read at the start and after each pass.
    expect(await bounded([true, true, true, true], 100, [0, 40, 80, 120, 200])).toEqual({
      passes: 3,
      idle: false,
      asked: 3,
    });
    expect(await bounded([true, true], 100, [0, 100])).toEqual({
      passes: 1,
      idle: false,
      asked: 1,
    });
  });
  it("is the mocked one when the route asks", async () => {
    expect(await runBounded(5)).toEqual({ passes: 2, idle: true });
    budgets.length = 0;
  });
});
describe("the tick route", () => {
  it("does not exist without a secret, or with one that is too short", async () => {
    expect((await call("GET")).status).toBe(404);
    vi.stubEnv("CRON_SECRET", "short");
    expect((await call("POST", { authorization: "Bearer short" })).status).toBe(404);
    expect(budgets).toEqual([]);
  });
  it("answers only the bearer of the secret, for GET as Vercel calls it and for POST", async () => {
    vi.stubEnv("CRON_SECRET", secret);
    for (const headers of [
      {},
      { authorization: secret },
      { authorization: `Bearer ${secret}x` },
      { authorization: `Bearer ${"x".repeat(40)}` },
      { authorization: `bearer ${secret}` },
    ]) {
      const refused = await call("GET", headers);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ error: "unauthenticated" });
    }
    expect(budgets).toEqual([]);
    for (const method of ["GET", "POST"] as const) {
      const answered = await call(method, { authorization: `Bearer ${secret}` });
      expect(answered.status).toBe(200);
      expect(await answered.json()).toEqual({ passes: 2, idle: true, ms: expect.any(Number) });
    }
    expect(budgets).toEqual([45_000, 45_000]);
  });
  it("takes a shorter or longer budget, up to a limit, and ignores nonsense", async () => {
    vi.stubEnv("CRON_SECRET", secret);
    const headers = { authorization: `Bearer ${secret}` };
    for (const query of [
      "?budget=5000",
      "?budget=999999",
      "?budget=-3",
      "?budget=abc",
      "?budget=0",
    ])
      await call("GET", headers, query);
    expect(budgets).toEqual([5000, 50_000, 45_000, 45_000, 45_000]);
  });
});
