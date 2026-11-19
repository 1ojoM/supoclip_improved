import { initialSplitRanges, moveSplitBoundary, parseVideoTime } from "./video-splits";

it("limits initial parts to 90 minutes even when fewer parts leave gaps", () => {
  expect(initialSplitRanges(18000, 2)).toEqual([{ start: 0, end: 5400 }, { start: 9000, end: 14400 }]);
});

it("clamps moving handles against neighbours, source bounds, and maximum length", () => {
  const ranges = [{ start: 100, end: 200 }, { start: 300, end: 400 }];
  expect(moveSplitBoundary(ranges, 0, "end", 350, 10000)[0]).toEqual({ start: 100, end: 300 });
  expect(moveSplitBoundary(ranges, 1, "start", 0, 10000)[1]).toEqual({ start: 200, end: 400 });
  expect(moveSplitBoundary(ranges, 1, "end", 9999, 10000)[1].end).toBe(5700);
  expect(moveSplitBoundary(ranges, 0, "start", 300, 10000)[0].start).toBe(199);
});

it("accepts readable time codes and rejects malformed ones", () => {
  expect(parseVideoTime("02:30:05")).toBe(9005);
  expect(parseVideoTime("00:60:00")).toBeNull();
  expect(parseVideoTime("nonsense")).toBeNull();
});
