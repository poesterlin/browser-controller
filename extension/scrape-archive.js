import { strToU8, zipSync } from './vendor/fflate.js';

const README =
  'Open route .mhtml files in Chromium. Screenshots are full-page stitched captures taken after each route loaded. The archive may contain page content visible to your browser; review it before sharing.\n';

export function createScrapeArchive(files, metadata) {
  const entries = {
    'metadata.json': strToU8(`${JSON.stringify(metadata, null, 2)}\n`),
    'README.txt': strToU8(README),
  };
  for (const file of files) entries[file.name] = file.data;
  return zipSync(entries, { level: 6 });
}
