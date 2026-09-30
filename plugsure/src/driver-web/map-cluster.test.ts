import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The driver app map groups stations that would overlap (clusterPoints, in
 * index.html between the map-cluster markers). The function is read out of the
 * page itself, so the test runs what drivers run.
 */
const html = readFileSync(fileURLToPath(new URL('./index.html', import.meta.url)), 'utf8');
const src = html.slice(html.indexOf('// map-cluster:start'), html.indexOf('// map-cluster:end'));
type Pt = { _x: number; _y: number };
const clusterPoints = new Function(`${src}; return clusterPoints;`)() as (pts: Pt[], scale: number, radius: number) => Array<{ members: number[]; x: number; y: number }>;

const mercX = (lon: number) => (lon + 180) / 360;
const mercY = (lat: number) => { const s = Math.sin((lat * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const at = (lat: number, lon: number): Pt => ({ _x: mercX(lon), _y: mercY(lat) });
const scaleAt = (zoom: number) => 256 * 2 ** zoom;

// Three malls in Jakarta a few hundred metres apart, one in Bandung, one in Surabaya.
const pts = [at(-6.2246, 106.7998), at(-6.2254, 106.8021), at(-6.2231, 106.8012), at(-6.9175, 107.6191), at(-7.2575, 112.7521)];

describe('driver map: grouping stations', () => {
  test('zoomed out over Java, the three Jakarta stations are one group; Bandung and Surabaya stand alone', () => {
    const g = clusterPoints(pts, scaleAt(7), 52);
    assert.equal(g.length, 3);
    assert.deepEqual(g.map((x) => x.members.length).sort(), [1, 1, 3]);
    const jkt = g.find((x) => x.members.length === 3)!;
    assert.deepEqual(jkt.members.sort(), [0, 1, 2]);
    // placed at the middle of its stations
    assert.ok(Math.abs(jkt.x - (pts[0]!._x + pts[1]!._x + pts[2]!._x) / 3) < 1e-12);
  });

  test('zoomed in on Jakarta, they separate; every station is in exactly one group at any zoom', () => {
    assert.equal(clusterPoints(pts, scaleAt(17), 52).length, 5);
    for (const z of [3, 6, 9, 12, 15, 18]) {
      const all = clusterPoints(pts, scaleAt(z), 52).flatMap((x) => x.members).sort();
      assert.deepEqual(all, [0, 1, 2, 3, 4], `zoom ${z}`);
    }
  });

  test('radius 0 turns grouping off; an empty map has no groups', () => {
    assert.equal(clusterPoints(pts, scaleAt(4), 0).length, 5);
    assert.deepEqual(clusterPoints([], scaleAt(10), 52), []);
  });

  test('two thousand stations group in one quick pass', () => {
    const many: Pt[] = [];
    for (let i = 0; i < 2000; i++) many.push(at(-6 - (i % 50) * 0.02, 106 + Math.floor(i / 50) * 0.02));
    const t0 = performance.now();
    const g = clusterPoints(many, scaleAt(8), 52);
    assert.ok(performance.now() - t0 < 200, 'fast');
    assert.equal(g.reduce((n, x) => n + x.members.length, 0), 2000);
    assert.ok(g.length < 100, `grouped (${g.length} groups)`);
  });
});
