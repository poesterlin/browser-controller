import { describe, expect, test } from 'bun:test';
import { easedScrollPositions, uniformScrollPositions } from '../extension/scroll-easing.js';

describe('extension scroll easing', () => {
  test('starts at the top, ends at the bottom, and is strictly monotonic', () => {
    for (const [total, frames] of [
      [1033, 20],
      [5000, 60],
      [300, 8],
    ] as Array<[number, number]>) {
      const positions = easedScrollPositions(total, frames);
      expect(positions[0]).toBe(0);
      expect(positions[positions.length - 1]).toBe(total);
      for (let index = 1; index < positions.length; index += 1)
        expect(positions[index]).toBeGreaterThan(positions[index - 1]);
    }
  });

  test('accelerates smoothly and caps at +30% of base speed', () => {
    const total = 100_000;
    const frames = 400;
    const positions = easedScrollPositions(total, frames);
    const deltas: number[] = [];
    for (let index = 1; index < positions.length; index += 1)
      deltas.push(positions[index] - positions[index - 1]);
    const base = total / frames;
    const maxDelta = Math.max(...deltas);
    const minDelta = Math.min(...deltas);
    // Early frames start near 70% of base speed, never below 60%.
    expect(minDelta).toBeGreaterThan(base * 0.6);
    // The cap holds: no frame advances more than 30% above base speed.
    expect(maxDelta).toBeLessThanOrEqual(base * 1.3 + 1);
    expect(maxDelta).toBeGreaterThan(base * 1.2);
    // The cap is reached mid-scroll; the ends sit at 70% of base speed.
    expect(deltas[Math.floor(deltas.length / 2)]).toBeGreaterThan(
      deltas[deltas.length - 2] * 1.5,
    );
  });

  test('decelerates symmetric to the start and glides into the bottom pause', () => {
    const total = 100_000;
    const frames = 400;
    const positions = easedScrollPositions(total, frames);
    const delta = (index: number) => positions[index + 1] - positions[index];
    const first = delta(1);
    const last = delta(positions.length - 2);
    const capDelta = (total / frames) * 1.3;
    // Ends near the start speed (symmetric), well below the cap.
    expect(last).toBeGreaterThan(first * 0.75);
    expect(last).toBeLessThan(first * 1.35);
    expect(last).toBeLessThan(capDelta * 0.75);
    // The cap is still reached in the middle.
    expect(Math.max(...Array.from({ length: positions.length - 1 }, (_, i) => delta(i))))
      .toBeGreaterThan(capDelta * 0.9);
  });

  test('falls back to uniform spacing for short animations', () => {
    expect(easedScrollPositions(300, 2)).toEqual(uniformScrollPositions(300, 2));
  });

  test('handles single-frame and zero-distance animations', () => {
    expect(easedScrollPositions(0, 1)).toEqual([0]);
    expect(uniformScrollPositions(0, 3)).toEqual([0]);
    expect(uniformScrollPositions(100, 1)).toEqual([0, 100]);
  });

  test('produces deterministic output', () => {
    expect(easedScrollPositions(4000, 33)).toEqual(easedScrollPositions(4000, 33));
  });
});
