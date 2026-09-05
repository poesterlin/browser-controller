export interface GifFrame {
  width: number;
  height: number;
  pixels: Uint8ClampedArray | Uint8Array;
  delay?: number;
}
export declare class GifEncoder {
  readonly width: number;
  readonly height: number;
  frames: number;
  constructor(options: { width: number; height: number; fps?: number; loop?: number; dither?: boolean });
  addFrame(pixels: Uint8ClampedArray | Uint8Array, delayOverride?: number): void;
  finish(): Uint8Array;
}
export declare function encodeGif(
  frames: GifFrame[],
  options?: { fps?: number; loop?: number; dither?: boolean },
): Uint8Array;
