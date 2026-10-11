import { getRequestConfig } from "next-intl/server";
import { headers } from "next/headers";
import { negotiateLocale } from "../domain/locale";
import english from "./en.json";
import german from "./de.json";
export default getRequestConfig(async () => {
  const locale = negotiateLocale((await headers()).get("accept-language"));
  return { locale, messages: locale === "de" ? german : english, timeZone: "UTC" };
});
