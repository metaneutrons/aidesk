import { headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { negotiateLocale } from "../../domain/locale";
import { OwnerRecovery } from "../../components/owner-recovery";
import english from "../../i18n/en.json";
import german from "../../i18n/de.json";
export const dynamic = "force-dynamic";
export default async function RecoverPage() {
  const locale = negotiateLocale((await headers()).get("accept-language"));
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "de" ? german : english}
      timeZone="UTC"
    >
      <OwnerRecovery />
    </NextIntlClientProvider>
  );
}
