export interface ScrapeArchiveFile {
  name: string;
  data: Uint8Array;
}

export declare function createScrapeArchive(
  files: ScrapeArchiveFile[],
  metadata: Record<string, unknown>,
): Uint8Array;
