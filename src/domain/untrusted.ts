// Text that a sender wrote and an agent reads. It is data: nothing here decides
// whether it is harmless. The text is cleaned of characters a person does not see
// but a model reads, and simple patterns of instructions are reported as flags so
// that the agent and the people who check its work can see them. A flag never
// blocks, because a pattern that blocks also blocks a customer who quotes it.

// Characters that carry no visible text, as code point ranges: the Unicode tag
// block (used to hide whole sentences), zero-width characters, left-to-right and
// right-to-left marks, the bidirectional embeddings, the word joiner and the
// invisible operators, the isolates, the soft hyphen and the byte order mark. The
// ranges are numbers on purpose: invisible characters in the source would be
// invisible to a reviewer too.
const hiddenRanges: readonly (readonly [number, number])[] = [
  [0xe0000, 0xe007f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0x00ad, 0x00ad],
  [0xfeff, 0xfeff],
];
// Control characters other than the line and tab characters of plain text.
const isControl = (code: number) =>
  code <= 0x08 ||
  code === 0x0b ||
  code === 0x0c ||
  (code >= 0x0e && code <= 0x1f) ||
  (code >= 0x7f && code <= 0x9f);
const isHidden = (code: number) =>
  isControl(code) || hiddenRanges.some(([from, to]) => code >= from && code <= to);
export interface Cleaned {
  text: string;
  // How many invisible characters were removed.
  removed: number;
}
// A leading byte order mark is an artefact of a file and is dropped without being
// counted.
export function cleanText(value: string): Cleaned {
  let removed = 0;
  let text = "";
  let first = true;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const bom = first && code === 0xfeff;
    first = false;
    if (bom) continue;
    if (isHidden(code)) removed += 1;
    else text += char;
  }
  return { text, removed };
}
export const flagIds = [
  "instruction_override",
  "role_marker",
  "secrecy_request",
  "exfiltration_hint",
  "hidden_characters",
  // A document had parts that a reader does not see (hidden text, sheets, slides)
  // and that were left out.
  "hidden_content",
] as const;
export type Flag = (typeof flagIds)[number];
const patterns: [Exclude<Flag, "hidden_characters" | "hidden_content">, RegExp][] = [
  [
    "instruction_override",
    /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|guidelines?)\b/i,
  ],
  [
    "instruction_override",
    /\b(ignoriere|vergiss|missachte)\b[^.\n]{0,40}\b(vorherigen|obigen|bisherigen|alle|deine)\b[^.\n]{0,30}\b(anweisungen|instruktionen|regeln|vorgaben)\b/i,
  ],
  ["instruction_override", /\bnew (instructions?|task|rules)\s*:/i],
  ["role_marker", /^\s*(system|assistant|developer)\s*:/im],
  [
    "role_marker",
    /\b(you are now|act as|pretend to be)\s+(a|an|the)\b[^.\n]{0,40}\b(assistant|ai|bot|model|agent|admin|administrator|developer|system)\b/i,
  ],
  [
    "role_marker",
    /\bdu bist (jetzt|ab jetzt)\s+(ein|eine|der|die)\b[^.\n]{0,40}\b(assistent|assistentin|agent|ki|bot|administrator|admin|entwickler)\b/i,
  ],
  ["role_marker", /<\|?(im_start|im_end|system|assistant)\|?>/i],
  [
    "secrecy_request",
    /\b(do not|don't|never)\b[^.\n]{0,30}\b(tell|inform|mention|show)\b[^.\n]{0,30}\b(user|customer|operator|anyone|human)\b/i,
  ],
  [
    "secrecy_request",
    /\b(sage|erwähne|zeige)\b[^.\n]{0,30}\b(niemandem|dem kunden nicht|dem nutzer nicht)\b/i,
  ],
  // An address that carries data in its query, as an image or a link, and a
  // request to send data somewhere.
  ["exfiltration_hint", /!\[[^\]]*\]\(https?:\/\/[^)\s]*\?[^)\s]*\)/i],
  [
    "exfiltration_hint",
    /\b(send|post|forward|upload|email|mail)\b[^.\n]{0,60}\b(to|an)\b[^.\n]{0,30}(https?:\/\/|[\w.+-]+@[\w-]+\.[\w.]+)/i,
  ],
];
// The flags of a text, once each, in a fixed order.
export function flagsOf(text: string, removed: number, leftOut = 0): Flag[] {
  const found = new Set<Flag>();
  if (removed > 0) found.add("hidden_characters");
  if (leftOut > 0) found.add("hidden_content");
  for (const [flag, pattern] of patterns) if (pattern.test(text)) found.add(flag);
  return flagIds.filter((flag) => found.has(flag));
}
