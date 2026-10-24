/**
 * Dev-only safety for tools/city/build-city-assets.ts: inspects a `zipinfo` listing before anything is extracted.
 * Refuses symlink entries, absolute or parent-relative paths, and archives whose total uncompressed size exceeds a cap.
 */
export const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;

export function checkZipListing(listing: string, maxBytes = MAX_EXTRACTED_BYTES): { entries: number; bytes: number } {
  let entries = 0, bytes = 0;
  for (const line of listing.split('\n')) {
    const f = line.trim().split(/\s+/);
    // Entry lines: <mode> <version> <os> <size> <type> <method> <date> <time> <path...>
    if (f.length < 9 || !/^[-dlbcps][-rwxXsStTa]{3,9}$/.test(f[0]) || !/^\d+$/.test(f[3])) continue;
    const path = f.slice(8).join(' ');
    if (f[0][0] === 'l') throw new Error(`archive contains a symlink entry: ${path}`);
    if (path.startsWith('/') || path.split('/').includes('..')) throw new Error(`archive entry escapes the extraction folder: ${path}`);
    entries++;
    bytes += Number(f[3]);
    if (bytes > maxBytes) throw new Error(`archive expands beyond ${maxBytes} bytes`);
  }
  if (!entries) throw new Error('archive listing has no entries');
  // Fail closed: every entry zipinfo announces must have been parsed (and checked) above.
  const declared = /number of entries:\s*(\d+)/.exec(listing)?.[1] ?? /^(\d+) files?,/m.exec(listing)?.[1];
  if (declared === undefined) throw new Error('archive listing has no entry count');
  if (Number(declared) !== entries) throw new Error(`archive listing declares ${declared} entries but ${entries} were checked`);
  return { entries, bytes };
}
