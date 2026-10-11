import { headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { negotiateLocale } from "../../domain/locale";
import { safeReturnTo } from "../../domain/navigation";
import { Login } from "../../components/login";
import english from "../../i18n/en.json";
import german from "../../i18n/de.json";
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const locale = negotiateLocale((await headers()).get("accept-language"));
  const { next } = await searchParams;
  const returnTo = safeReturnTo(next);
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "de" ? german : english}
      timeZone="UTC"
    >
      <Login
        returnTo={returnTo}
        development={process.env.DEV_BOOTSTRAP === "true" && process.env.NODE_ENV === "development"}
      />
    </NextIntlClientProvider>
  );
}
