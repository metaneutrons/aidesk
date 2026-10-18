import { brandingOfPage } from "../../../server/branding";
import { textOn } from "../../../domain/branding";
import { getLimits } from "../../../server/limits";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { negotiateLocale, type Locale } from "../../../domain/locale";
import { DomainError } from "../../../server/errors";
import { getPortalTicket } from "../../../server/portal";
import { portalHost } from "../../../server/portal-domains";
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
  let locale: Locale = negotiateLocale((await headers()).get("accept-language"));
  let view;
  try {
    const sent = await headers();
    // On a name of the customer page only the links that belong to it open.
    const host = await portalHost(sent.get("x-forwarded-host") ?? sent.get("host"));
    view = await getPortalTicket(token, locale, host);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
  }
  // A project that fixed the language of its page gets that language; the others the one of the browser.
  const branding = view ? await brandingOfPage(view.projectId) : null;
  if (branding?.language) locale = branding.language;
  // The project's own wording replaces the built-in text of the page.
  const own = view ? await activeTexts(view.projectId, locale) : {};
  const limits = await getLimits();
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
        brand={
          branding
            ? {
                name: branding.displayName,
                headerText: branding.headerText,
                accent: branding.accentColor,
                accentText: branding.accentColor ? textOn(branding.accentColor) : null,
                hasLogo: branding.hasLogo,
              }
            : null
        }
        fileLimits={{ count: limits.portalFiles, mib: limits.portalTotalMiB }}
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
