import { locales, type Locale } from "./locale";
// Language detection for incoming mail, limited to the languages the product
// supports. It counts function words that belong to only one of them, which is
// reliable for ordinary sentences and says so when it is not: a short or mixed
// text yields no language instead of a guess.
const lists: Record<Locale, string> = {
  en: "the and you your with have has had are was were this that these those for not but from they them their what which when will would could should can please thanks thank hello there been about into than then also just only our any all how why where who its it's i'm i've don't doesn't can't won't isn't",
  de: "der die das und ich sie ist nicht ein eine einen einem einer mit für auf dem den des von zu wir sind wird werden habe haben hat hatte bitte danke hallo wie warum wo wer aber auch noch nur mein meine unser unsere kann können könnte müssen muss wenn dass diese dieser dieses nach bei über sehr schon doch oder wäre würde",
};
const words = (locale: Locale) => lists[locale].split(" ");
// Words that occur in both lists mean nothing for the decision.
const shared = new Set(words("en").filter((word) => words("de").includes(word)));
const own = (locale: Locale): ReadonlySet<string> =>
  new Set(words(locale).filter((word) => !shared.has(word)));
const stopwords: Record<Locale, ReadonlySet<string>> = { en: own("en"), de: own("de") };
export interface Detection {
  language: Locale | null;
  // too_short and ambiguous leave the language open.
  reason: "reliable" | "too_short" | "ambiguous";
  words: number;
}
// What a person wrote, without quoted history, code and links.
function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}
export function detectLanguage(text: string): Detection {
  const words = prose(text)
    .toLowerCase()
    .match(/[a-zäöüß']+/g);
  const count = words?.length ?? 0;
  if (!words || count < 8) return { language: null, reason: "too_short", words: count };
  const hits = { en: 0, de: 0 };
  for (const word of words)
    for (const locale of locales) if (stopwords[locale].has(word)) hits[locale] += 1;
  const [best, other] = hits.de >= hits.en ? (["de", "en"] as const) : (["en", "de"] as const);
  // Several own function words, clearly more than the other language's.
  if (hits[best] >= 3 && hits[best] >= 2 * hits[other] + 1)
    return { language: best, reason: "reliable", words: count };
  return { language: null, reason: "ambiguous", words: count };
}
export interface LanguageDecision {
  language: string;
  source: "ticket" | "requester" | "detected" | "project";
  // The detection could not name a language, so the fallback was used.
  undecided: boolean;
}
// Explicit ticket choice, then the requester's preference, then a reliable
// detection, then the project's default. The operator's interface language is
// not an input: it never decides what the customer receives.
export function decideLanguage(input: {
  ticketChoice?: string | null;
  requesterPreference?: string | null;
  detection?: Detection | null;
  projectDefault: string;
}): LanguageDecision {
  if (input.ticketChoice)
    return { language: input.ticketChoice, source: "ticket", undecided: false };
  if (input.requesterPreference)
    return { language: input.requesterPreference, source: "requester", undecided: false };
  if (input.detection?.language)
    return { language: input.detection.language, source: "detected", undecided: false };
  return { language: input.projectDefault, source: "project", undecided: input.detection != null };
}
