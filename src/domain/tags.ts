// Tags are short labels that a team puts on tickets to find them again. One
// definition serves the server, which enforces it, and the desk, which shows
// the normalized form before saving.
export const maxTags = 10;
export const tagPattern = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,29}$/u;
export function normalizeTag(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, "-");
}
