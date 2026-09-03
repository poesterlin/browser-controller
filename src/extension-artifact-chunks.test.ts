import { describe, expect, test } from 'bun:test';
import { artifactChunks } from '../extension/artifact-chunks.js';

describe('extension artifact chunks', () => {
  test('splits and reconstructs binary artifacts without loss', () => {
    const source = Uint8Array.from({ length: 1025 }, (_, index) => index % 251);
    const chunks = [...artifactChunks(source, 128)];
    const reconstructed = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      reconstructed.set(chunk, offset);
      offset += chunk.length;
    }

    expect(chunks).toHaveLength(9);
    expect(reconstructed).toEqual(source);
  });

  test('rejects invalid chunk sizes', () => {
    expect(() => [...artifactChunks(new Uint8Array(), 0)]).toThrow('positive integer');
  });
});
