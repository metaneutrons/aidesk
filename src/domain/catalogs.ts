import { createTranslator } from "next-intl";
export function validateCatalog(
  reference: Record<string, string>,
  candidate: Record<string, string>,
): void {
  const keys = Object.keys(reference).sort();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(candidate).sort()))
    throw new Error("catalog_keys_mismatch");
  const translate = createTranslator({
    locale: "en",
    messages: candidate,
    onError: (error) => {
      throw error;
    },
  });
  for (const key of keys) {
    const message = candidate[key];
    if (!message?.trim()) throw new Error("empty_catalog_message");
    // Supply a sample for every argument the message names, so a new
    // placeholder is validated without changing this gate.
    const names = [...message.matchAll(/\{\s*([A-Za-z_]\w*)/g)].map((match) => match[1] ?? "");
    translate(key, Object.fromEntries(names.map((name) => [name, name === "count" ? 2 : name])));
  }
}
