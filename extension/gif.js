// GIF89a encoder used by the scrollgif capture mode. Deterministic and
// quality-first: median-cut palette quantization per frame with optional
// Floyd–Steinberg dithering (serpentine), and spec-conformant variable-width
// LZW. Frames are full-size replacements with local color tables, so no
// transparency or cross-frame compositing is involved. Dithering defaults to
// off: its error pattern changes from frame to frame, which reads as shimmer
// during playback, while plain nearest-color banding stays static.

const MAX_LZW_CODES = 4096;
const BITS_PER_INDEX = 8;
const MIN_CODE_SIZE = BITS_PER_INDEX;

class ByteWriter {
  constructor() {
    this._buffer = new Uint8Array(1 << 16);
    this.length = 0;
  }
  _ensure(extra) {
    if (this.length + extra <= this._buffer.length) return;
    let size = this._buffer.length;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this._buffer.subarray(0, this.length));
    this._buffer = next;
  }
  u8(value) {
    this._ensure(1);
    this._buffer[this.length++] = value & 0xff;
  }
  u16(value) {
    this._ensure(2);
    this._buffer[this.length++] = value & 0xff;
    this._buffer[this.length++] = (value >> 8) & 0xff;
  }
  bytes(data) {
    this._ensure(data.length);
    this._buffer.set(data, this.length);
    this.length += data.length;
  }
  toUint8Array() {
    return this._buffer.slice(0, this.length);
  }
}

function channelValue(bucket, shift) {
  return (bucket >> shift) & 31;
}

function makeBox(histogram, buckets) {
  let count = 0;
  let rMin = 31, rMax = 0, gMin = 31, gMax = 0, bMin = 31, bMax = 0;
  for (const bucket of buckets) {
    const entries = histogram[bucket];
    if (!entries) continue;
    count += entries;
    const r = channelValue(bucket, 10);
    const g = channelValue(bucket, 5);
    const b = channelValue(bucket, 0);
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    if (g < gMin) gMin = g;
    if (g > gMax) gMax = g;
    if (b < bMin) bMin = b;
    if (b > bMax) bMax = b;
  }
  return { buckets, count, rMin, rMax, gMin, gMax, bMin, bMax };
}

// Median cut over the 5-bit-per-channel histogram. Returns at most 256 RGB
// triples; fewer when the frame uses fewer distinct 5-bit buckets.
function medianCutPalette(rgba) {
  const histogram = new Int32Array(1 << 15);
  for (let index = 0; index < rgba.length; index += 4)
    histogram[((rgba[index] >> 3) << 10) | ((rgba[index + 1] >> 3) << 5) | (rgba[index + 2] >> 3)] += 1;
  const buckets = [];
  for (let bucket = 0; bucket < histogram.length; bucket += 1)
    if (histogram[bucket]) buckets.push(bucket);
  if (!buckets.length) return [[0, 0, 0]];
  let boxes = [makeBox(histogram, buckets)];
  const widestRange = (box) => Math.max(box.rMax - box.rMin, box.gMax - box.gMin, box.bMax - box.bMin);
  while (boxes.length < 256) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let index = 0; index < boxes.length; index += 1) {
      const box = boxes[index];
      if (widestRange(box) === 0) continue;
      const score = box.count * (widestRange(box) + 1);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;
    const box = boxes[bestIndex];
    const range = widestRange(box);
    const shift = range === box.rMax - box.rMin ? 10 : range === box.gMax - box.gMin ? 5 : 0;
    const sorted = box.buckets.slice().sort((a, b) => channelValue(a, shift) - channelValue(b, shift));
    const half = box.count / 2;
    let accumulated = 0;
    let cut = 0;
    while (cut < sorted.length - 1) {
      accumulated += histogram[sorted[cut]];
      if (accumulated >= half) break;
      cut += 1;
    }
    const left = sorted.slice(0, cut + 1);
    const right = sorted.slice(cut + 1);
    if (!left.length || !right.length) break;
    boxes.splice(bestIndex, 1, makeBox(histogram, left), makeBox(histogram, right));
  }
  return boxes.map((box) => {
    let total = 0, rSum = 0, gSum = 0, bSum = 0;
    for (const bucket of box.buckets) {
      const entries = histogram[bucket];
      if (!entries) continue;
      total += entries;
      rSum += entries * (channelValue(bucket, 10) * 8 + 4);
      gSum += entries * (channelValue(bucket, 5) * 8 + 4);
      bSum += entries * (channelValue(bucket, 0) * 8 + 4);
    }
    return [
      Math.min(255, Math.round(rSum / total)),
      Math.min(255, Math.round(gSum / total)),
      Math.min(255, Math.round(bSum / total)),
    ];
  });
}

function buildNearestTable(palette) {
  const nearest = new Int32Array(1 << 15);
  for (let bucket = 0; bucket < nearest.length; bucket += 1) {
    const r = channelValue(bucket, 10) * 8 + 4;
    const g = channelValue(bucket, 5) * 8 + 4;
    const b = channelValue(bucket, 0) * 8 + 4;
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < palette.length; index += 1) {
      const dr = r - palette[index][0];
      const dg = g - palette[index][1];
      const db = b - palette[index][2];
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    nearest[bucket] = best;
  }
  return nearest;
}

const clamp255 = (value) => (value < 0 ? 0 : value > 255 ? 255 : value);

// Serpentine Floyd–Steinberg dithering into palette indices. `errors` is a
// reusable Float32Array (width*height*3) so frames avoid fresh allocations.
function ditherToIndices(rgba, width, height, palette, nearest, errors) {
  errors.fill(0);
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const leftToRight = (y & 1) === 0;
    for (let stepX = 0; stepX < width; stepX += 1) {
      const x = leftToRight ? stepX : width - 1 - stepX;
      const pixel = (y * width + x) * 4;
      const slot = (y * width + x) * 3;
      const r = clamp255(rgba[pixel] + errors[slot]);
      const g = clamp255(rgba[pixel + 1] + errors[slot + 1]);
      const b = clamp255(rgba[pixel + 2] + errors[slot + 2]);
      const index = nearest[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
      indices[y * width + x] = index;
      const er = r - palette[index][0];
      const eg = g - palette[index][1];
      const eb = b - palette[index][2];
      const rightX = leftToRight ? x + 1 : x - 1;
      const spread = (targetX, targetY, factor) => {
        if (targetX < 0 || targetX >= width || targetY >= height) return;
        const target = (targetY * width + targetX) * 3;
        errors[target] += (er * factor) / 16;
        errors[target + 1] += (eg * factor) / 16;
        errors[target + 2] += (eb * factor) / 16;
      };
      spread(rightX, y, 7);
      spread(leftToRight ? x - 1 : x + 1, y + 1, 3);
      spread(x, y + 1, 5);
      spread(rightX, y + 1, 1);
    }
  }
  return indices;
}

// GIF variant of LZW: variable code width (late change), clear on overflow.
function lzwEncode(indices) {
  const clearCode = 1 << MIN_CODE_SIZE;
  const endCode = clearCode + 1;
  let codeSize = MIN_CODE_SIZE + 1;
  let nextCode = endCode + 1;
  const dictionary = new Map();
  const writer = new ByteWriter();
  let bitBuffer = 0;
  let bitCount = 0;
  const emit = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      writer.u8(bitBuffer & 0xff);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };
  emit(clearCode);
  let prefix = indices[0];
  for (let index = 1; index < indices.length; index += 1) {
    const current = indices[index];
    const key = (prefix << BITS_PER_INDEX) | current;
    const entry = dictionary.get(key);
    if (entry !== undefined) {
      prefix = entry;
      continue;
    }
    emit(prefix);
    if (nextCode === MAX_LZW_CODES) {
      // Table is full: reset it so the stream stays decodable.
      emit(clearCode);
      dictionary.clear();
      nextCode = endCode + 1;
      codeSize = MIN_CODE_SIZE + 1;
    } else {
      // The decoder's table lags one entry behind, so the width must grow
      // before this entry is added, not after.
      if (nextCode >= (1 << codeSize) && codeSize < 12) codeSize += 1;
      dictionary.set(key, nextCode++);
    }
    prefix = current;
  }
  emit(prefix);
  emit(endCode);
  if (bitCount > 0) writer.u8(bitBuffer & 0xff);
  return writer.toUint8Array();
}

function writeLzwStream(writer, indices) {
  writer.u8(MIN_CODE_SIZE);
  const encoded = lzwEncode(indices);
  for (let offset = 0; offset < encoded.length; offset += 255) {
    const size = Math.min(255, encoded.length - offset);
    writer.u8(size);
    writer.bytes(encoded.subarray(offset, offset + size));
  }
  writer.u8(0);
}

export class GifEncoder {
  constructor({ width, height, fps = 15, loop = 0, dither = false } = {}) {
    if (!Number.isInteger(width) || width < 1 || width > 65535)
      throw new Error('gif_width_invalid');
    if (!Number.isInteger(height) || height < 1 || height > 65535)
      throw new Error('gif_height_invalid');
    if (!Number.isFinite(fps) || fps < 1 || fps > 50) throw new Error('gif_fps_invalid');
    this.width = width;
    this.height = height;
    this.dither = !!dither;
    // GIF delays are in 1/100 s. Decoders round delays below 2 up to 10, so
    // keep the minimum at 2.
    this.delay = Math.max(2, Math.round(100 / fps));
    this.loop = loop;
    this.frames = 0;
    this.writer = new ByteWriter();
    this.errors = new Float32Array(width * height * 3);
  }

  addFrame(rgba, delayOverride) {
    if (rgba.length !== this.width * this.height * 4) throw new Error('gif_frame_size_mismatch');
    const writer = this.writer;
    if (this.frames === 0) {
      for (const byte of [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) writer.u8(byte); // GIF89a
      writer.u16(this.width);
      writer.u16(this.height);
      writer.u8(0x70); // no global table, 8-bit color resolution
      writer.u8(0); // background color index
      writer.u8(0); // pixel aspect ratio
      if (this.loop != null) {
        const label = [0x21, 0xff, 0x0b];
        for (const byte of label) writer.u8(byte);
        for (const char of 'NETSCAPE2.0') writer.u8(char.charCodeAt(0));
        writer.u8(3);
        writer.u8(1);
        writer.u16(this.loop);
        writer.u8(0);
      }
    }
    const palette = medianCutPalette(rgba);
    const nearest = buildNearestTable(palette);
    let indices;
    if (this.dither)
      indices = ditherToIndices(rgba, this.width, this.height, palette, nearest, this.errors);
    else {
      indices = new Uint8Array(this.width * this.height);
      for (let pixel = 0, index = 0; pixel < rgba.length; pixel += 4, index += 1)
        indices[index] = nearest[((rgba[pixel] >> 3) << 10) | ((rgba[pixel + 1] >> 3) << 5) | (rgba[pixel + 2] >> 3)];
    }
    const delay = Math.max(1, Math.round(delayOverride ?? this.delay));
    writer.u8(0x21); // graphic control extension
    writer.u8(0xf9);
    writer.u8(4);
    writer.u8(0x08); // disposal: restore to background, no transparency
    writer.u8(delay & 0xff);
    writer.u8((delay >> 8) & 0xff);
    writer.u8(0); // transparent color index (unused)
    writer.u8(0);
    writer.u8(0x2c); // image descriptor
    writer.u16(0);
    writer.u16(0);
    writer.u16(this.width);
    writer.u16(this.height);
    let tableBits = 1;
    while (1 << tableBits < palette.length) tableBits += 1;
    if (tableBits > BITS_PER_INDEX) throw new Error('gif_palette_too_large');
    writer.u8(0x80 | (tableBits - 1)); // local color table follows
    const tableSize = 1 << tableBits;
    for (let index = 0; index < tableSize; index += 1) {
      const color = palette[index] ?? [0, 0, 0];
      writer.u8(color[0]);
      writer.u8(color[1]);
      writer.u8(color[2]);
    }
    writeLzwStream(writer, indices);
    this.frames += 1;
  }

  finish() {
    this.writer.u8(0x3b); // trailer
    return this.writer.toUint8Array();
  }
}

export function encodeGif(frames, options = {}) {
  if (!frames.length) throw new Error('gif_frame_missing');
  const first = frames[0];
  const encoder = new GifEncoder({
    width: first.width,
    height: first.height,
    ...options,
  });
  for (const frame of frames) encoder.addFrame(frame.pixels ?? frame, frame.delay);
  return encoder.finish();
}
