import { describe, expect, it } from "vitest";
import { eachLimited } from "../src/worker/limited";
const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
describe("working through a list with a limit", () => {
  it("runs at most the limit at once, runs more than one, and handles every item", async () => {
    let running = 0;
    let most = 0;
    const done: number[] = [];
    await eachLimited(
      Array.from({ length: 25 }, (_, index) => index),
      4,
      async (item) => {
        running += 1;
        most = Math.max(most, running);
        await pause(5);
        running -= 1;
        done.push(item);
      },
    );
    expect(most).toBe(4);
    expect([...done].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, index) => index),
    );
  });
  it("takes the items in order and is done at once for an empty list", async () => {
    const started: number[] = [];
    await eachLimited([1, 2, 3], 1, (item) => {
      started.push(item);
      return Promise.resolve();
    });
    expect(started).toEqual([1, 2, 3]);
    await eachLimited([], 8, () => Promise.reject(new Error("not called")));
  });
  it("treats a limit below one as one", async () => {
    let running = 0;
    let most = 0;
    await eachLimited([1, 2, 3], 0, async () => {
      running += 1;
      most = Math.max(most, running);
      await pause(2);
      running -= 1;
    });
    expect(most).toBe(1);
  });
});
