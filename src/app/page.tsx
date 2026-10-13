import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { identify } from "../server/principal";
import { getOverview, listProjects, listTickets, operatorInfo } from "../server/operations";
import { listCeiling, listStep } from "../domain/paging";
import { DomainError } from "../server/errors";
import { effectiveLocale } from "../domain/locale";
import { Desk } from "../components/desk";
import english from "../i18n/en.json";
import german from "../i18n/de.json";
export const dynamic = "force-dynamic";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ ticket?: string; limit?: string }>;
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
  // How much of the list is loaded; more is asked for in steps from the desk.
  const requested = Number(parameters.limit);
  const limit = Number.isInteger(requested)
    ? Math.min(Math.max(requested, listStep), listCeiling)
    : listStep;
  const [projectList, ticketList, overview, operator] = await Promise.all([
    listProjects(principal),
    listTickets(principal, [], limit),
    getOverview(principal),
    operatorInfo(principal),
  ]);
  const locale = effectiveLocale(operator.locale, requestHeaders.get("accept-language"));
  const serialize = (ticket: (typeof ticketList)[number]) => ({
    ...ticket,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    pendingSince: ticket.pendingSince?.toISOString() ?? null,
    remindAt: ticket.remindAt?.toISOString() ?? null,
    resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
    junkAt: ticket.junkAt?.toISOString() ?? null,
  });
  const initialTickets = ticketList.map(serialize);
  const overviewData = {
    projects: overview.projects,
    oldest: overview.oldest.map(serialize),
  };
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "de" ? german : english}
      timeZone="UTC"
    >
      <Desk
        projects={projectList}
        initialTickets={initialTickets}
        overview={overviewData}
        listLimit={limit}
        operator={{ ...operator, id: principal.id }}
        initialTicketId={parameters.ticket ?? null}
        initialLocale={locale}
        localePreference={operator.locale}
        serverTime={Date.now()}
      />
    </NextIntlClientProvider>
  );
}
