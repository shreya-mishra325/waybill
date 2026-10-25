import { expect, test } from "bun:test";
import { samplePosition } from "../src/lib/network";

const points = [{x: 0, y: 0}, {x: 10, y: 20}, {x: 20, y: 0}];

test("motion samples interpolate instead of jumping between measured points", () => {
  expect(samplePosition(points, 0.25)).toEqual({x: 5, y: 10});
  expect(samplePosition(points, 0.5)).toEqual({x: 10, y: 20});
  expect(samplePosition(points, 0.75)).toEqual({x: 15, y: 10});
});

test("motion samples wrap at the end of a cycle and normalize negative offsets", () => {
  expect(samplePosition(points, 1)).toEqual(samplePosition(points, 0));
  expect(samplePosition(points, 2.25)).toEqual(samplePosition(points, 0.25));
  expect(samplePosition(points, -0.25)).toEqual(samplePosition(points, 0.75));
});

test("an incomplete measured path cannot silently produce invalid positions", () => {
  expect(() => samplePosition([], 0.5)).toThrow();
  expect(() => samplePosition([{x: 0, y: 0}], 0.5)).toThrow();
});

test("a longer landing page extends paths without reshaping existing sections", async () => {
  const { landingRoutes, networkLayout, ROUTES } = await import("../src/lib/network");
  const shorter = landingRoutes(networkLayout(1536, 2200));
  const longer = landingRoutes(networkLayout(1536, 4200));
  for (let index = 0; index < ROUTES.length; index++) {
    expect(shorter[index]!.startsWith(ROUTES[index]!)).toBe(true);
    expect(longer[index]!.startsWith(shorter[index]!)).toBe(true);
  }
});

test("distance-based particles retain their position when a path grows", async () => {
  const { sampleRoute } = await import("../src/lib/network");
  const first = {points: [{x: 0, y: 0}, {x: 10, y: 10}, {x: 20, y: 0}], length: 20, spacing: 10};
  const extended = {...first, points: [...first.points, {x: 30, y: 10}], length: 30};
  expect(sampleRoute(first, 15)).toEqual({x: 15, y: 5});
  expect(sampleRoute(extended, 15)).toEqual(sampleRoute(first, 15));
  expect(sampleRoute(first, -5)).toEqual(sampleRoute(first, 15));
});

test("a short final sample interval does not distort particle speed", async () => {
  const { sampleRoute } = await import("../src/lib/network");
  const route = {points: [{x: 0, y: 0}, {x: 10, y: 0}, {x: 15, y: 0}], length: 15, spacing: 10};
  expect(sampleRoute(route, 12.5)).toEqual({x: 12.5, y: 0});
  expect(sampleRoute(route, 15)).toEqual({x: 0, y: 0});
});

test("airplane progress is determined only by scroll distance and reverses without wrapping", async () => {
  const { scrollFlightDistance } = await import("../src/lib/network");
  const down = scrollFlightDistance(800, 1, 6000);
  expect(scrollFlightDistance(0, 1, 6000)).toBe(0);
  expect(down).toBeCloseTo(920);
  expect(scrollFlightDistance(400, 1, 6000)).toBeCloseTo(460);
  expect(scrollFlightDistance(800, 1, 6000)).toBe(down);
  expect(scrollFlightDistance(-20, 1, 6000)).toBe(0);
  expect(scrollFlightDistance(10000, 1, 6000)).toBe(6000);
});

test("flight samples clamp to either endpoint instead of resetting to the start", async () => {
  const { sampleFlight } = await import("../src/lib/network");
  const route = {points: [{x: 0, y: 0}, {x: 10, y: 10}, {x: 15, y: 0}], length: 15, spacing: 10};
  expect(sampleFlight(route, -10)).toEqual({x: 0, y: 0});
  expect(sampleFlight(route, 12.5)).toEqual({x: 12.5, y: 5});
  expect(sampleFlight(route, 15)).toEqual({x: 15, y: 0});
  expect(sampleFlight(route, 500)).toEqual({x: 15, y: 0});
});

test("page growth preserves the reference hero flight and existing flight geometry", async () => {
  const { flightPath, networkLayout, HERO_FLIGHT_PATH } = await import("../src/lib/network");
  const short = flightPath(networkLayout(1536, 2200));
  const long = flightPath(networkLayout(1536, 5000));
  expect(short.startsWith(HERO_FLIGHT_PATH)).toBe(true);
  expect(long.startsWith(short)).toBe(true);
});


test("flight milestones keep the airplane travelling through the page without timing or scroll-direction jumps", async () => {
  const { scrollFlightDistance, flightSegments, networkLayout } = await import("../src/lib/network");
  const stops = [{scroll: 343, distance: 1100}, {scroll: 1163, distance: 2800}];
  expect(scrollFlightDistance(0, 1, 2800, stops)).toBe(0);
  expect(scrollFlightDistance(343, 1, 2800, stops)).toBe(1100);
  expect(scrollFlightDistance(753, 1, 2800, stops)).toBe(1950);
  expect(scrollFlightDistance(1163, 1, 2800, stops)).toBe(2800);
  expect(scrollFlightDistance(343, 1, 2800, stops)).toBe(1100);
  const mobile = flightSegments(networkLayout(390, 5000));
  expect(mobile[0]!.d.startsWith("M712 622")).toBe(true);
});
