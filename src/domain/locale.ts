export const locales = ["en", "de"] as const;
export type Locale = (typeof locales)[number];
export function resolveLocale(value: string | null | undefined): Locale {
  return value?.toLowerCase().split(/[-_]/)[0] === "de" ? "de" : "en";
}
// A stored operator preference wins; without one the browser decides, with
// English as the explicit fallback.
export function effectiveLocale(preference: string | null, acceptLanguage: string | null): Locale {
  return preference ? resolveLocale(preference) : negotiateLocale(acceptLanguage);
}
export function negotiateLocale(header: string | null): Locale {
  if (!header) return "en";
  const choices = header
    .split(",")
    .map((entry, index) => {
      const [language = "", ...parameters] = entry.trim().split(";");
      const q = parameters.find((part) => part.trim().startsWith("q="));
      return {
        language: language.toLowerCase(),
        quality: q ? Number(q.trim().slice(2)) : 1,
        index,
      };
    })
    .filter(
      (choice) =>
        Number.isFinite(choice.quality) &&
        choice.quality > 0 &&
        choice.quality <= 1 &&
        locales.some(
          (locale) => choice.language === locale || choice.language.startsWith(locale + "-"),
        ),
    )
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  return resolveLocale(choices[0]?.language);
}
