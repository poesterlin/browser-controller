import { describe, expect, test } from 'bun:test';
import { GifEncoder, encodeGif } from '../extension/gif.js';

// Minimal GIF89a reader used to verify the encoder: parses the block
// structure and decodes LZW per the GIF spec (late width change, clear on
// full table) so decoded frames can be compared against the encoder input.

interface DecodedFrame {
  delay: number;
  disposal: number;
  width: number;
  height: number;
  palette: Array<[number, number, number]>;
  indices: Uint8Array;
}

interface DecodedGif {
  width: number;
  height: number;
  loopCount: number | null;
  frames: DecodedFrame[];
  trailerPresent: boolean;
}

function decodeLzw(data: Uint8Array, minCodeSize: number, expected: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let table: number[][] = [];
  const reset = () => {
    codeSize = minCodeSize + 1;
    table = [];
    for (let index = 0; index < clearCode; index += 1) table.push([index]);
    table.push([]);
    table.push([]);
  };
  reset();
  const out: number[] = [];
  let prev: number[] | null = null;
  let bitPos = 0;
  const readCode = () => {
    let code = 0;
    for (let bit = 0; bit < codeSize; bit += 1) {
      const byteIndex = bitPos >> 3;
      if (byteIndex >= data.length) throw new Error('lzw stream truncated');
      code |= ((data[byteIndex] >> (bitPos & 7)) & 1) << bit;
      bitPos += 1;
    }
    return code;
  };
  while (out.length < expected) {
    const code = readCode();
    if (code === clearCode) {
      reset();
      prev = null;
      continue;
    }
    if (code === endCode) break;
    let entry: number[];
    if (code < table.length && table[code].length) entry = table[code];
    else if (prev) entry = [...prev, prev[0]];
    else throw new Error(`lzw invalid first code ${code}`);
    for (const value of entry) out.push(value);
    if (prev) {
      table.push([...prev, entry[0]]);
      if (table.length === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    prev = entry;
  }
  if (out.length !== expected) throw new Error(`lzw decoded ${out.length} of ${expected}`);
  return Uint8Array.from(out);
}

function readGif(bytes: Uint8Array): DecodedGif {
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (signature !== 'GIF89a') throw new Error(`unexpected signature ${signature}`);
  const u16 = (offset: number) => bytes[offset] | (bytes[offset + 1] << 8);
  const gif: DecodedGif = { width: u16(6), height: u16(8), loopCount: null, frames: [], trailerPresent: false };
  let offset = 13;
  let pendingDelay = 0;
  let pendingDisposal = 0;
  while (offset < bytes.length) {
    const block = bytes[offset++];
    if (block === 0x3b) {
      gif.trailerPresent = true;
      break;
    }
    if (block === 0x21) {
      const label = bytes[offset++];
      if (label === 0xf9) {
        const size = bytes[offset++];
        pendingDisposal = (bytes[offset] >> 2) & 7;
        pendingDelay = bytes[offset + 1] | (bytes[offset + 2] << 8);
        offset += size;
        if (bytes[offset++] !== 0) throw new Error('gce terminator missing');
      } else if (label === 0xff) {
        const size = bytes[offset++];
        const application = String.fromCharCode(...bytes.subarray(offset, offset + size));
        offset += size;
        const data: number[] = [];
        let sub: number;
        while ((sub = bytes[offset++]) !== 0) {
          for (let index = 0; index < sub; index += 1) data.push(bytes[offset + index]);
          offset += sub;
        }
        if (application === 'NETSCAPE2.0' && data[0] === 1) gif.loopCount = data[1] | (data[2] << 8);
      } else {
        let sub: number;
        while ((sub = bytes[offset++]) !== 0) offset += sub;
      }
    } else if (block === 0x2c) {
      const width = u16(offset + 4);
      const height = u16(offset + 6);
      const packed = bytes[offset + 8];
      offset += 9;
      const palette: Array<[number, number, number]> = [];
      if (packed & 0x80) {
        const tableSize = 1 << ((packed & 7) + 1);
        for (let index = 0; index < tableSize; index += 1)
          palette.push([bytes[offset + index * 3], bytes[offset + index * 3 + 1], bytes[offset + index * 3 + 2]]);
        offset += tableSize * 3;
      }
      const minCodeSize = bytes[offset++];
      const data: number[] = [];
      let sub: number;
      while ((sub = bytes[offset++]) !== 0) {
        for (let index = 0; index < sub; index += 1) data.push(bytes[offset + index]);
        offset += sub;
      }
      gif.frames.push({
        delay: pendingDelay,
        disposal: pendingDisposal,
        width,
        height,
        palette,
        indices: decodeLzw(Uint8Array.from(data), minCodeSize, width * height),
      });
      pendingDelay = 0;
      pendingDisposal = 0;
    } else throw new Error(`unexpected block 0x${block.toString(16)} at ${offset - 1}`);
  }
  if (!gif.trailerPresent) throw new Error('trailer missing');
  return gif;
}

function solidFrame(width: number, height: number, [r, g, b]: [number, number, number]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = r;
    pixels[index + 1] = g;
    pixels[index + 2] = b;
    pixels[index + 3] = 255;
  }
  return pixels;
}

function frameFrom(width: number, height: number, paint: (x: number, y: number) => [number, number, number]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      const offset = (y * width + x) * 4;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = 255;
    }
  return pixels;
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('extension gif encoder', () => {
  test('round-trips bucket-aligned colors exactly', () => {
    // 4, 124 and 252 sit exactly on 5-bit bucket centers, so quantization and
    // dithering introduce zero error and the decoded frame must match byte for byte.
    const width = 8;
    const height = 8;
    const color = (x: number, y: number): [number, number, number] => {
      const r = x < 4 ? 4 : 252;
      const g = y < 4 ? 4 : 124;
      return [r, g, (x + y) % 2 ? 252 : 4];
    };
    const pixels = frameFrom(width, height, color);
    const gif = readGif(encodeGif([{ width, height, pixels }], { fps: 20, loop: 0, dither: true }));
    expect(gif.frames).toHaveLength(1);
    expect(gif.frames[0].width).toBe(width);
    expect(gif.frames[0].height).toBe(height);
    expect(gif.frames[0].palette.length).toBeLessThanOrEqual(256);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const [r, g, b] = color(x, y);
        const index = gif.frames[0].indices[y * width + x];
        const [pr, pg, pb] = gif.frames[0].palette[index];
        expect([pr, pg, pb]).toEqual([r, g, b]);
      }
  });

  test('keeps gradient content within a tight average error', () => {
    const width = 96;
    const height = 64;
    const pixels = frameFrom(width, height, (x, y) => [
      Math.round((x / (width - 1)) * 255),
      Math.round((y / (height - 1)) * 255),
      Math.round(((x + y) / (width + height - 2)) * 255),
    ]);
    const gif = readGif(encodeGif([{ width, height, pixels }], { fps: 15, dither: true }));
    expect(gif.frames[0].palette.length).toBeLessThanOrEqual(256);
    let inputSum = 0;
    let outputSum = 0;
    for (let index = 0; index < width * height; index += 1) {
      inputSum += pixels[index * 4] + pixels[index * 4 + 1] + pixels[index * 4 + 2];
      const [r, g, b] = gif.frames[0].palette[gif.frames[0].indices[index]];
      outputSum += r + g + b;
    }
    const averageError = Math.abs(inputSum - outputSum) / (width * height);
    expect(averageError).toBeLessThan(4);
  });

  test('survives dictionary overflow on high-entropy frames', () => {
    const width = 220;
    const height = 160;
    const random = mulberry32(42);
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      pixels[index * 4] = Math.floor(random() * 256);
      pixels[index * 4 + 1] = Math.floor(random() * 256);
      pixels[index * 4 + 2] = Math.floor(random() * 256);
      pixels[index * 4 + 3] = 255;
    }
    const gif = readGif(encodeGif([{ width, height, pixels }], { fps: 20, dither: true }));
    let inputSum = 0;
    let outputSum = 0;
    for (let index = 0; index < width * height; index += 1) {
      inputSum += pixels[index * 4] + pixels[index * 4 + 1] + pixels[index * 4 + 2];
      const [r, g, b] = gif.frames[0].palette[gif.frames[0].indices[index]];
      outputSum += r + g + b;
    }
    const averageError = Math.abs(inputSum - outputSum) / (width * height);
    expect(averageError).toBeLessThan(12);
  });

  test('writes frame delays, disposal, hold overrides, and loop count', () => {
    const frames = [1, 2, 3].map((value) => ({
      width: 4,
      height: 4,
      pixels: solidFrame(4, 4, [value * 80, 4, 4]),
    }));
    const encoder = new GifEncoder({ width: 4, height: 4, fps: 20, loop: 2 });
    encoder.addFrame(frames[0].pixels, 30);
    encoder.addFrame(frames[1].pixels);
    encoder.addFrame(frames[2].pixels, 30);
    const gif = readGif(encoder.finish());
    expect(gif.frames.map((frame) => frame.delay)).toEqual([30, 5, 30]);
    expect(gif.frames.every((frame) => frame.disposal === 2)).toBe(true);
    expect(gif.loopCount).toBe(2);
    expect(gif.frames.every((frame) => frame.palette.length <= 256)).toBe(true);
  });

  test('defaults loop forever and omits nothing structural', () => {
    const gif = readGif(encodeGif([{ width: 2, height: 2, pixels: solidFrame(2, 2, [255, 255, 255]) }]));
    expect(gif.loopCount).toBe(0);
    expect(gif.width).toBe(2);
    expect(gif.height).toBe(2);
    expect(gif.trailerPresent).toBe(true);
  });

  test('deterministically encodes identical input', () => {
    const options = { fps: 20, loop: 0 } as const;
    const frame = { width: 32, height: 32, pixels: frameFrom(32, 32, (x, y) => [x * 8, y * 8, (x * y) % 256]) };
    const first = encodeGif([frame], options);
    const second = encodeGif([{ ...frame, pixels: frame.pixels.slice() }], options);
    expect([...first]).toEqual([...second]);
  });

  test('rejects invalid dimensions, frame sizes, and frame rates', () => {
    expect(() => new GifEncoder({ width: 0, height: 10 })).toThrow('gif_width_invalid');
    expect(() => new GifEncoder({ width: 10, height: 70000 })).toThrow('gif_height_invalid');
    expect(() => new GifEncoder({ width: 10, height: 10, fps: 0 })).toThrow('gif_fps_invalid');
    const encoder = new GifEncoder({ width: 4, height: 4 });
    expect(() => encoder.addFrame(new Uint8ClampedArray(4 * 4 * 3))).toThrow('gif_frame_size_mismatch');
    expect(() => encodeGif([], {})).toThrow('gif_frame_missing');
  });
});
