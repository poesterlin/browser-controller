// Scroll animation frame positions for the scrollgif capture mode. Frame
// timing in the GIF is uniform, so acceleration is expressed through uneven
// per-frame scroll distances: the scroll starts at 70% of base speed, eases
// smoothly up to a hard cap of 130% of base speed at the midpoint, and eases
// back down symmetrically so it glides into the bottom pause. The symmetric
// profile averages exactly 1.0, so "base speed" is the true average and the
// cap is a real +30%.

const START_FACTOR = 0.7;
const CAP_FACTOR = 1.3;
const EASING_MIN_FRAMES = 6;

function smoothstep(x) {
  return x * x * (3 - 2 * x);
}

export function uniformScrollPositions(total, frameCount) {
  const step = total / frameCount;
  const positions = [];
  for (let index = 0; index <= frameCount; index += 1) {
    const y = Math.min(total, Math.round(index * step));
    if (positions[positions.length - 1] !== y) positions.push(y);
  }
  if (positions[positions.length - 1] !== total) positions.push(total);
  return positions;
}

export function easedScrollPositions(total, frameCount) {
  if (frameCount < EASING_MIN_FRAMES) return uniformScrollPositions(total, frameCount);
  const velocity = (t) =>
    t < 0.5
      ? START_FACTOR + (CAP_FACTOR - START_FACTOR) * smoothstep(t / 0.5)
      : CAP_FACTOR - (CAP_FACTOR - START_FACTOR) * smoothstep((t - 0.5) / 0.5);
  const deltas = [];
  for (let index = 0; index < frameCount; index += 1)
    deltas.push(velocity((index + 0.5) / frameCount));
  const positions = [0];
  let traveled = 0;
  for (const delta of deltas) {
    traveled += (delta / deltas.length) * total;
    const y = Math.min(total, Math.round(traveled));
    if (positions[positions.length - 1] !== y) positions.push(y);
  }
  if (positions[positions.length - 1] !== total) positions.push(total);
  return positions;
}
