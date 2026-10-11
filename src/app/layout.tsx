import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { negotiateLocale, resolveLocale } from "../domain/locale";
import { identify } from "../server/principal";
import { operatorInfo } from "../server/operations";
import { DomainError } from "../server/errors";
import "./globals.css";
export const metadata: Metadata = {
  title: "aidesk",
  description: "A clear support desk for all your projects.",
};
export default async function RootLayout({ children }: { children: ReactNode }) {
  const requestHeaders = new Headers(await headers());
  let locale = negotiateLocale(requestHeaders.get("accept-language"));
  if (requestHeaders.has("cookie") || requestHeaders.has("authorization")) {
    try {
      locale = resolveLocale((await operatorInfo(await identify(requestHeaders))).locale);
    } catch (error) {
      if (!(error instanceof DomainError && error.code === "unauthenticated")) throw error;
    }
  }
  return (
    <html lang={locale} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
