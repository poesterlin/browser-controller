export function* artifactChunks(bytes, chunkBytes = 256 * 1024) {
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1)
    throw new Error('chunkBytes must be a positive integer');
  for (let offset = 0; offset < bytes.length; offset += chunkBytes)
    yield bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length));
}
