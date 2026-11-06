import {expect, test} from 'bun:test';
import {measureNetworkPath} from '../src/lib/network-geometry';
import {flightPath, landingRoutes, networkLayout, ROUTES} from '../src/lib/network';

test('distance sampling preserves straight paths and a short final interval', () => {
  const route=measureNetworkPath('M0 0 C5 0 10 0 15 0', 10);
  expect(route.length).toBeCloseTo(15, 6);
  expect(route.points).toEqual([{x:0,y:0},{x:10,y:0},{x:15,y:0}]);
});

test('smooth cubic controls match the equivalent explicit curves', () => {
  const shorthand=measureNetworkPath('M0 0 C0 100 100 100 100 0 S200 -100 200 0');
  const explicit=measureNetworkPath('M0 0 C0 100 100 100 100 0 C100 -100 200 -100 200 0');
  expect(shorthand).toEqual(explicit);
  expect(shorthand.length).toBeCloseTo(400, 1);
});

test('all responsive network and flight paths produce finite distance samples', () => {
  for(const width of [1536,1280,768,390]){
    const layout=networkLayout(width,5000);
    for(const path of [...ROUTES,...landingRoutes(layout),flightPath(layout)]){
      const route=measureNetworkPath(path);
      expect(route.points.length).toBe(Math.ceil(route.length/route.spacing)+1);
      expect(route.points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))).toBe(true);
      expect(route.points[0]).toEqual({x:Number(path.match(/^M(-?[\d.]+)/)![1]),y:Number(path.match(/^M-?[\d.]+\s+(-?[\d.]+)/)![1])});
    }
  }
});

test('unsupported geometry and invalid spacing fail explicitly', () => {
  for(const path of ['', 'M0 0', 'M0 0 L10 10', 'M0 0 C1 2 3', 'M0 0 C0 0 0 0 0 0'])expect(()=>measureNetworkPath(path)).toThrow();
  for(const spacing of [0,-1,NaN,Infinity])expect(()=>measureNetworkPath('M0 0 C1 1 2 2 3 3',spacing)).toThrow();
});
