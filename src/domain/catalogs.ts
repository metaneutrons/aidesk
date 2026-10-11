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
    if (!candidate[key]?.trim()) throw new Error("empty_catalog_message");
    translate(key, { count: 2, project: "Project", customer: "Customer" });
  }
}
