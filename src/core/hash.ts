/**
 * 53-bit hash of a whole string (cyrb53). Used to key cached outlines and to name uploaded fonts, so two
 * files that differ anywhere get different keys. Results are remembered per string, because the same
 * multi-megabyte image data is hashed on every render.
 */
const memo = new Map<string, string>();

export function hashString(s: string): string {
  const hit = memo.get(s);
  if (hit) return hit;
  let h1 = 0xdeadbeef ^ s.length,
    h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const out = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + '-' + s.length.toString(36);
  memo.set(s, out);
  if (memo.size > 64) memo.delete(memo.keys().next().value as string);
  return out;
}
