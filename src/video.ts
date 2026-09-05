// Video assembly for the scrollgif command: the extension transfers a
// length-prefixed sequence of full-color JPEG frames, and the CLI converts
// them into a playable video. MP4 via ffmpeg is used when available;
// otherwise the frames are muxed into a motion-JPEG AVI (RIFF) with no
// external dependencies.

import { spawn } from 'node:child_process';

const JPEG_MAGIC = 0xffd8;

export function parseJpegSequence(archive: Buffer): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (offset < archive.length) {
    if (offset + 4 > archive.length) throw new Error('jpeg_sequence_truncated_header');
    const length = archive.readUInt32LE(offset);
    offset += 4;
    if (length < 2 || offset + length > archive.length)
      throw new Error('jpeg_sequence_truncated_frame');
    const frame = archive.subarray(offset, offset + length);
    if (frame.readUInt16BE(0) !== JPEG_MAGIC) throw new Error('jpeg_sequence_invalid_frame');
    frames.push(frame);
    offset += length;
  }
  return frames;
}

export function buildJpegSequence(frames: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const frame of frames) total += 4 + frame.length;
  const archive = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const frame of frames) {
    archive.writeUInt32LE(frame.length, offset);
    offset += 4;
    Buffer.from(frame.buffer, frame.byteOffset, frame.length).copy(archive, offset);
    offset += frame.length;
  }
  return archive;
}

interface GrowBuffer {
  length: number;
  reserve(extra: number): void;
  u32(value: number, at?: number): void;
  u16(value: number): void;
  u8(value: number): void;
  fourcc(text: string): void;
  data(bytes: Uint8Array): void;
  toUint8Array(): Uint8Array;
}

function growBuffer(): GrowBuffer {
  const state = { bytes: new Uint8Array(1 << 16), length: 0 };
  const view = () => new DataView(state.bytes.buffer);
  const reserve = (extra: number) => {
    if (state.length + extra <= state.bytes.length) return;
    let size = state.bytes.length;
    while (size < state.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(state.bytes.subarray(0, state.length));
    state.bytes = next;
  };
  return {
    get length() {
      return state.length;
    },
    reserve,
    u32(value: number, at?: number) {
      reserve(4);
      view().setUint32(at ?? state.length, value, true);
      if (at === undefined) state.length += 4;
    },
    u16(value: number) {
      reserve(2);
      view().setUint16(state.length, value, true);
      state.length += 2;
    },
    u8(value: number) {
      reserve(1);
      state.bytes[state.length] = value & 0xff;
      state.length += 1;
    },
    fourcc(text: string) {
      reserve(4);
      for (let index = 0; index < 4; index += 1)
        state.bytes[state.length + index] = text.charCodeAt(index);
      state.length += 4;
    },
    data(bytes: Uint8Array) {
      reserve(bytes.length);
      state.bytes.set(bytes, state.length);
      state.length += bytes.length;
    },
    toUint8Array() {
      return state.bytes.slice(0, state.length);
    },
  };
}

const AVIIF_KEYFRAME = 0x10;
const RIFF_ALIGN = 2;

// Muxes JPEG frames into a motion-JPEG AVI (MJPG fourcc), which every common
// player and ffmpeg understands. Output dimensions must be even.
export function aviFromJpegFrames(
  frames: Uint8Array[],
  { fps, width, height }: { fps: number; width: number; height: number },
): Uint8Array {
  if (!frames.length) throw new Error('avi_frame_missing');
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new Error('avi_fps_invalid');
  if (!Number.isInteger(width) || width < 1 || width > 65535) throw new Error('avi_width_invalid');
  if (!Number.isInteger(height) || height < 1 || height > 65535) throw new Error('avi_height_invalid');

  const totalBytes = frames.reduce((sum, frame) => sum + frame.length, 0);
  const maxFrame = frames.reduce((max, frame) => Math.max(max, frame.length), 0);
  const out = growBuffer();

  // Header list -------------------------------------------------------------
  out.fourcc('RIFF');
  const riffSizePosition = out.length;
  out.u32(0); // patched after every chunk is written
  out.fourcc('AVI ');

  out.fourcc('LIST');
  const hdrlSizePosition = out.length;
  out.u32(0); // patched
  out.fourcc('hdrl');

  out.fourcc('avih');
  out.u32(56);
  out.u32(Math.round(1_000_000 / fps)); // dwMicroSecPerFrame
  out.u32(Math.ceil((totalBytes / frames.length) * fps)); // dwMaxBytesPerSec
  out.u32(0); // dwPaddingGranularity
  out.u32(AVIIF_KEYFRAME); // dwFlags: AVIF_HASINDEX
  out.u32(frames.length); // dwTotalFrames
  out.u32(0); // dwInitialFrames
  out.u32(1); // dwStreams
  out.u32(maxFrame + 8); // dwSuggestedBufferSize
  out.u32(width);
  out.u32(height);
  out.u32(0);
  out.u32(0);
  out.u32(0);
  out.u32(0);

  out.fourcc('LIST');
  const strlSizePosition = out.length;
  out.u32(0); // patched
  out.fourcc('strl');

  out.fourcc('strh');
  out.u32(56);
  out.fourcc('vids');
  out.fourcc('MJPG');
  out.u32(0); // dwFlags
  out.u16(0); // wPriority
  out.u16(0); // wLanguage
  out.u32(0); // dwInitialFrames
  out.u32(1); // dwScale
  out.u32(fps); // dwRate: frames per second
  out.u32(0); // dwStart
  out.u32(frames.length); // dwLength
  out.u32(maxFrame + 8); // dwSuggestedBufferSize
  out.u32(0xffffffff); // dwQuality
  out.u32(0); // dwSampleSize
  out.u16(0); // rcFrame.left
  out.u16(0); // rcFrame.top
  out.u16(width); // rcFrame.right
  out.u16(height); // rcFrame.bottom

  out.fourcc('strf'); // BITMAPINFOHEADER
  out.u32(40);
  out.u32(width);
  out.u32(height);
  out.u16(1); // biPlanes
  out.u16(24); // biBitCount
  out.fourcc('MJPG'); // biCompression
  out.u32(width * height * 3); // biSizeImage
  out.u32(0); // biXPelsPerMeter
  out.u32(0); // biYPelsPerMeter
  out.u32(0); // biClrUsed
  out.u32(0); // biClrImportant

  // Patch the strl list size: everything after this list's size field.
  out.u32(out.length - (strlSizePosition + 4), strlSizePosition);
  // Patch the hdrl list size.
  out.u32(out.length - (hdrlSizePosition + 4), hdrlSizePosition);

  // Movie list --------------------------------------------------------------
  out.fourcc('LIST');
  const moviSizePosition = out.length;
  out.u32(0); // patched
  out.fourcc('movi');
  const firstChunkPosition = out.length;
  const offsets: Array<{ position: number; length: number }> = [];
  for (const frame of frames) {
    offsets.push({ position: out.length - firstChunkPosition, length: frame.length });
    out.fourcc('00dc');
    out.u32(frame.length);
    out.data(frame);
    if (frame.length % RIFF_ALIGN) out.u8(0);
  }
  out.u32(out.length - (moviSizePosition + 4), moviSizePosition);

  // Index -------------------------------------------------------------------
  out.fourcc('idx1');
  out.u32(frames.length * 16);
  for (const entry of offsets) {
    out.fourcc('00dc');
    out.u32(AVIIF_KEYFRAME);
    out.u32(entry.position);
    out.u32(entry.length);
  }

  out.u32(out.length - 8, riffSizePosition);
  return out.toUint8Array();
}

export interface VideoResult {
  bytes: number;
  container: 'mp4' | 'avi';
  encoder: string;
}

// Convert full-color JPEG frames into a video file. ffmpeg produces an H.264
// MP4 when available; otherwise the frames are muxed into a motion-JPEG AVI.
export async function writeVideo(
  output: string,
  frames: Uint8Array[],
  options: { fps: number; width: number; height: number },
): Promise<VideoResult> {
  const ffmpeg = await findFfmpeg();
  if (ffmpeg) {
    const encoder = await pickH264Encoder(ffmpeg);
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-y', '-v', 'error',
        '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(options.fps), '-i', '-',
        '-an', '-c:v', encoder, '-preset', 'veryfast', '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-movflags', '+faststart',
        output,
      ];
      const child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg_failed: ${stderr.trim() || code}`)),
      );
      void writeAll(child.stdin, frames).catch(reject);
    });
    const stat = await import('node:fs/promises').then((fs) => fs.stat(output));
    return { bytes: stat.size, container: 'mp4', encoder };
  }
  const { writeFile } = await import('node:fs/promises');
  const avi = aviFromJpegFrames(frames, options);
  await writeFile(output, avi);
  return { bytes: avi.length, container: 'avi', encoder: 'mjpeg-avi' };
}

async function writeAll(stdin: NodeJS.WritableStream | null, frames: Uint8Array[]): Promise<void> {
  if (!stdin) throw new Error('ffmpeg_stdin_unavailable');
  for (const frame of frames) {
    if (!stdin.write(Buffer.from(frame.buffer, frame.byteOffset, frame.length)))
      await new Promise<void>((resolve) => stdin.once('drain', resolve));
  }
  await new Promise<void>((resolve, reject) => {
    stdin.end(() => resolve());
    stdin.on('error', reject);
  });
}

async function findFfmpeg(): Promise<string | undefined> {
  const path = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  for (const directory of path.split(':')) {
    const candidate = `${directory}/ffmpeg`;
    try {
      await import('node:fs/promises').then((fs) => fs.access(candidate, fs.constants.X_OK));
      return candidate;
    } catch {}
  }
  return undefined;
}

async function pickH264Encoder(ffmpeg: string): Promise<string> {
  const encoders = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
    child.on('error', reject);
    child.on('close', () => resolve(stdout));
  });
  return encoders.includes('libx264') ? 'libx264' : 'mpeg4';
}
