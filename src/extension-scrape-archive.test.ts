import { describe, expect, test } from 'bun:test';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { createScrapeArchive } from '../extension/scrape-archive.js';

describe('extension scrape archive', () => {
  test('packages binary captures and metadata without base64 expansion', () => {
    const archive = createScrapeArchive(
      [
        { name: 'routes/001-index.mhtml', data: strToU8('rendered page') },
        { name: 'screenshots/001-index.png', data: new Uint8Array([137, 80, 78, 71]) },
      ],
      { url: 'https://example.com/', routes: 1 },
    );
    const files = unzipSync(archive);

    expect(strFromU8(files['routes/001-index.mhtml'])).toBe('rendered page');
    expect([...files['screenshots/001-index.png']]).toEqual([137, 80, 78, 71]);
    expect(JSON.parse(strFromU8(files['metadata.json']))).toEqual({
      url: 'https://example.com/',
      routes: 1,
    });
    expect(strFromU8(files['README.txt'])).toContain('review it before sharing');
  });
});
