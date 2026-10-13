import type { Metadata } from "next";
import { headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { negotiateLocale } from "../../../domain/locale";
import { DomainError } from "../../../server/errors";
import { getPortalTicket } from "../../../server/portal";
import { activeTexts } from "../../../server/texts";
import { portalMessageKeys } from "../../../domain/texts";
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
  // The project's own wording replaces the built-in text of the page.
  const own = view ? await activeTexts(view.projectId, locale) : {};
  // The page needs the ticket and its messages, not which project they belong to.
  const shown = view
    ? (Object.fromEntries(Object.entries(view).filter(([name]) => name !== "projectId")) as Omit<
        typeof view,
        "projectId"
      >)
    : null;
  const messages: Record<string, string> = { ...(locale === "de" ? german : english) };
  for (const [key, messageKey] of Object.entries(portalMessageKeys)) {
    const text = own[key];
    if (text !== undefined) messages[messageKey] = text;
  }
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      <Portal
        token={token}
        locale={locale}
        view={
          shown
            ? {
                ...shown,
                ticket: { ...shown.ticket, createdAt: shown.ticket.createdAt.toISOString() },
                messages: shown.messages.map((message) => ({
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
