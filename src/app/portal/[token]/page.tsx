import type { Metadata } from "next";
import { headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { negotiateLocale } from "../../../domain/locale";
import { DomainError } from "../../../server/errors";
import { getPortalTicket } from "../../../server/portal";
import { Portal } from "../../../components/portal";
import english from "../../../i18n/en.json";
import german from "../../../i18n/de.json";
export const dynamic = "force-dynamic";
// The link is the credential: it is not indexed and not sent on as a referrer.
export const metadata: Metadata = {
  title: "Support",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default async function PortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const locale = negotiateLocale((await headers()).get("accept-language"));
  let view;
  try {
    view = await getPortalTicket(token);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
  }
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "de" ? german : english}
      timeZone="UTC"
    >
      <Portal
        token={token}
        locale={locale}
        view={
          view
            ? {
                ...view,
                ticket: { ...view.ticket, createdAt: view.ticket.createdAt.toISOString() },
                messages: view.messages.map((message) => ({
                  ...message,
                  createdAt: message.createdAt.toISOString(),
                })),
              }
            : null
        }
      />
    </NextIntlClientProvider>
  );
}
