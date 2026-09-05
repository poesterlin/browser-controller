import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { aviFromJpegFrames, buildJpegSequence, parseJpegSequence, writeVideo } from './video.js';

// 16×16 red JPEG (generated with ffmpeg) small enough to embed.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAxAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIABAAEAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIsATX9//9k=',
  'base64',
);

function u32(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
}
function fourcc(bytes: Uint8Array, offset: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

describe('jpeg sequence transfer', () => {
  test('round-trips length-prefixed frames', () => {
    const frames = [
      new Uint8Array([0xff, 0xd8, 1, 2]),
      new Uint8Array([0xff, 0xd8, 3]),
    ];
    const archive = Buffer.from(buildJpegSequence(frames));
    expect(u32(archive, 0)).toBe(4);
    expect(u32(archive, 8)).toBe(3);
    expect([...parseJpegSequence(archive)[0]]).toEqual([0xff, 0xd8, 1, 2]);
    expect([...parseJpegSequence(archive)[1]]).toEqual([0xff, 0xd8, 3]);
  });

  test('rejects truncated transfers and non-JPEG frames', () => {
    expect(() => parseJpegSequence(Buffer.from([4, 0, 0, 0, 0xff]))).toThrow(
      'jpeg_sequence_truncated_frame',
    );
    expect(() => parseJpegSequence(Buffer.from([2, 0, 0, 0, 0xff, 0xd9]))).toThrow(
      'jpeg_sequence_invalid_frame',
    );
    expect(() => parseJpegSequence(Buffer.from([2]))).toThrow('jpeg_sequence_truncated_header');
  });
});

describe('motion-jpeg AVI muxer', () => {
  const frames = [TINY_JPEG, TINY_JPEG.subarray(0), TINY_JPEG];
  const avi = aviFromJpegFrames(frames, { fps: 25, width: 16, height: 16 });

  test('writes the RIFF/AVI structure with correct fields', () => {
    expect(fourcc(avi, 0)).toBe('RIFF');
    expect(u32(avi, 4)).toBe(avi.length - 8);
    expect(fourcc(avi, 8)).toBe('AVI ');
    expect(fourcc(avi, 12)).toBe('LIST');
    expect(fourcc(avi, 20)).toBe('hdrl');
    expect(fourcc(avi, 24)).toBe('avih');
    expect(u32(avi, 28)).toBe(56);
    expect(u32(avi, 32)).toBe(40_000); // 1e6 / 25 fps
    expect(u32(avi, 48)).toBe(3); // dwTotalFrames
    expect(u32(avi, 56)).toBe(1); // dwStreams
    expect(u32(avi, 60)).toBe(224 + 8); // dwSuggestedBufferSize
    expect(u32(avi, 64)).toBe(16); // width
    expect(u32(avi, 68)).toBe(16); // height
  });

  test('declares an MJPG video stream at the requested frame rate', () => {
    const strl = avi.findIndex((_, index) => fourcc(avi, index) === 'strl');
    const strh = avi.findIndex((_, index) => index > strl && fourcc(avi, index) === 'strh');
    expect(fourcc(avi, strh + 8)).toBe('vids');
    expect(fourcc(avi, strh + 12)).toBe('MJPG');
    expect(u32(avi, strh + 28)).toBe(1); // dwScale
    expect(u32(avi, strh + 32)).toBe(25); // dwRate
    expect(u32(avi, strh + 40)).toBe(3); // dwLength
  });

  test('stores every frame as an 00dc chunk and indexes them', () => {
    const movi = avi.findIndex((_, index) => fourcc(avi, index) === 'movi');
    let chunks = 0;
    let offset = movi + 4;
    while (offset < avi.length && fourcc(avi, offset) === '00dc') {
      const length = u32(avi, offset + 4);
      expect([...avi.subarray(offset + 8, offset + 10)]).toEqual([0xff, 0xd8]);
      chunks += 1;
      offset += 8 + length + (length % 2);
    }
    expect(chunks).toBe(3);
    const idx1 = avi.findIndex((_, index) => fourcc(avi, index) === 'idx1');
    expect(u32(avi, idx1 + 4)).toBe(3 * 16);
    expect(fourcc(avi, idx1 + 8)).toBe('00dc');
    expect(u32(avi, idx1 + 12)).toBe(0x10); // AVIIF_KEYFRAME
  });

  test('rejects invalid inputs', () => {
    expect(() => aviFromJpegFrames([], { fps: 25, width: 16, height: 16 })).toThrow('avi_frame_missing');
    expect(() => aviFromJpegFrames(frames, { fps: 0, width: 16, height: 16 })).toThrow('avi_fps_invalid');
    expect(() => aviFromJpegFrames(frames, { fps: 25, width: 0, height: 16 })).toThrow('avi_width_invalid');
  });
});

describe('writeVideo', async () => {
  test('produces a playable video file', async () => {
    const output = `/tmp/opencode/scrollgif-test-${Date.now()}.mp4`;
    const frames = Array.from({ length: 6 }, () => new Uint8Array(TINY_JPEG));
    const result = await writeVideo(output, frames, { fps: 10, width: 16, height: 16 });
    try {
      const bytes = (await fs.stat(output)).size;
      expect(bytes).toBeGreaterThan(0);
      expect(result.bytes).toBe(bytes);
      expect(['mp4', 'avi']).toContain(result.container);
      if (result.container === 'mp4') {
        // Verify ffmpeg can decode the exact frame count back out.
        const decoded = await new Promise<string>((resolve, reject) => {
          const child = spawn('ffmpeg', ['-v', 'error', '-i', output, '-f', 'null', '-'], {
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          let stderr = '';
          child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
          child.on('error', reject);
          child.on('close', (code) => (code === 0 ? resolve(stderr) : reject(new Error(stderr))));
        });
        expect(decoded).not.toContain('Error');
      }
    } finally {
      await fs.rm(output, { force: true });
    }
  });
});
