import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { identify } from "../server/principal";
import { listProjects, listTickets, operatorInfo } from "../server/operations";
import { DomainError } from "../server/errors";
import { effectiveLocale } from "../domain/locale";
import { Desk } from "../components/desk";
import english from "../i18n/en.json";
import german from "../i18n/de.json";
export const dynamic = "force-dynamic";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ ticket?: string }>;
}) {
  const parameters = await searchParams;
  const requestHeaders = new Headers(await headers());
  let principal;
  try {
    principal = await identify(requestHeaders);
  } catch (error) {
    if (error instanceof DomainError && error.code === "unauthenticated")
      redirect(
        `/login${parameters.ticket ? `?next=${encodeURIComponent(`/?ticket=${parameters.ticket}`)}` : ""}`,
      );
    throw error;
  }
  const [projectList, ticketList, operator] = await Promise.all([
    listProjects(principal),
    listTickets(principal),
    operatorInfo(principal),
  ]);
  const locale = effectiveLocale(operator.locale, requestHeaders.get("accept-language"));
  const initialTickets = ticketList.map((ticket) => ({
    ...ticket,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    pendingSince: ticket.pendingSince?.toISOString() ?? null,
    resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
  }));
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "de" ? german : english}
      timeZone="UTC"
    >
      <Desk
        projects={projectList}
        initialTickets={initialTickets}
        operator={{ ...operator, id: principal.id }}
        initialTicketId={parameters.ticket ?? null}
        initialLocale={locale}
        localePreference={operator.locale}
        serverTime={Date.now()}
      />
    </NextIntlClientProvider>
  );
}
