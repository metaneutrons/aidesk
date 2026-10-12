// What a translation must carry over unchanged: code, links, addresses and
// placeholders. Meaning is judged by qualification of the real provider (M4);
// this check only refuses a result that altered what must stay literal.
const patterns = [
  /```[\s\S]*?```/g,
  /`[^`\n]+`/g,
  /https?:\/\/[^\s)>\]]*[^\s)>\].,;:!?'"]/g,
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  /\{\{[^}]+\}\}|\{[A-Za-z_][\w.]*\}|%\([A-Za-z_]+\)s|%[sd]/g,
];
export function protectedSegments(markdown: string): string[] {
  const found: string[] = [];
  let rest = markdown;
  for (const pattern of patterns) {
    for (const match of rest.matchAll(pattern)) found.push(match[0]);
    // What was taken is not looked at again, so a link inside code counts once.
    rest = rest.replace(pattern, " ");
  }
  return found.sort();
}
export interface ProtectedCheck {
  ok: boolean;
  missing: string[];
  added: string[];
}
function remove(from: string[], item: string): boolean {
  const index = from.indexOf(item);
  if (index < 0) return false;
  from.splice(index, 1);
  return true;
}
export function checkProtected(source: string, translated: string): ProtectedCheck {
  const expected = protectedSegments(source);
  const actual = protectedSegments(translated);
  const added = actual.filter((item) => !remove(expected, item));
  return { ok: expected.length === 0 && added.length === 0, missing: expected, added };
}
export const translationStatuses = ["queued", "ready", "failed", "stale"] as const;
export type TranslationStatus = (typeof translationStatuses)[number];
