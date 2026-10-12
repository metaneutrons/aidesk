import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { NextIntlClientProvider } from "next-intl";
import { negotiateLocale } from "../../domain/locale";
import { OwnerSetup } from "../../components/owner-setup";
import { db } from "../../server/db";
import { user } from "../../server/db/schema";
import english from "../../i18n/en.json";
import german from "../../i18n/de.json";
export const dynamic = "force-dynamic";
export default async function SetupPage() {
  const locale = negotiateLocale((await headers()).get("accept-language"));
  const [owner] = await db()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.owner, true))
    .limit(1);
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "de" ? german : english}
      timeZone="UTC"
    >
      <OwnerSetup claimed={Boolean(owner)} />
    </NextIntlClientProvider>
  );
}
