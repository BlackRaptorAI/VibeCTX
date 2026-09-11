import { describe, it, expect } from "vitest";
import { mapLimit } from "../src/concurrency.js";

/**
 * mapLimit's first direct tests (A8 / PAR-721, Move 1): it had none before this move — only
 * indirect coverage through doctor / warm / autowarm. Moved verbatim out of doctor.ts, so its
 * behaviour is unchanged; these tests pin that behaviour at its new address.
 */
describe("mapLimit", () => {
  it("returns results in input order, even when completions arrive out of order", async () => {
    const delays: Record<number, number> = { 0: 30, 1: 10, 2: 20 };
    const out = await mapLimit([0, 1, 2], 3, async (i) => {
      await new Promise((resolve) => setTimeout(resolve, delays[i]));
      return `item-${i}`;
    });
    expect(out).toEqual(["item-0", "item-1", "item-2"]);
  });

  it("never runs more than `limit` calls concurrently", async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapLimit(items, 3, async (i) => {
      inFlight += 1;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return i;
    });
    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(maxObserved).toBeGreaterThan(0);
  });

  it("empty input returns an empty array and calls fn zero times", async () => {
    let calls = 0;
    const out = await mapLimit([], 4, async (i: number) => {
      calls += 1;
      return i;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it("limit greater than items.length runs every item, no more concurrently than items.length", async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const out = await mapLimit([1, 2, 3], 100, async (i) => {
      inFlight += 1;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return i * 2;
    });
    expect(out).toEqual([2, 4, 6]);
    expect(maxObserved).toBeLessThanOrEqual(3);
  });

  it("limit of 1 runs items strictly one at a time, in order", async () => {
    const order: number[] = [];
    const out = await mapLimit([1, 2, 3], 1, async (i) => {
      order.push(i);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return i;
    });
    expect(order).toEqual([1, 2, 3]);
    expect(out).toEqual([1, 2, 3]);
  });

  it("a rejecting fn rejects the whole mapLimit call", async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow("boom");
  });
});
