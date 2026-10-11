import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { effectiveLocale, negotiateLocale } from "../domain/locale";
import { identify } from "../server/principal";
import { operatorInfo } from "../server/operations";
import { DomainError } from "../server/errors";
import "./globals.css";
export const metadata: Metadata = {
  title: "aidesk",
  description: "Shared support inbox for multiple projects.",
};
// Applies an explicit appearance choice before the first paint. Without one,
// the stylesheet follows the operating system through color-scheme.
const themeScript = `try{var t=localStorage.getItem("aidesk:theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
export default async function RootLayout({ children }: { children: ReactNode }) {
  const requestHeaders = new Headers(await headers());
  let locale = negotiateLocale(requestHeaders.get("accept-language"));
  if (requestHeaders.has("cookie") || requestHeaders.has("authorization")) {
    try {
      locale = effectiveLocale(
        (await operatorInfo(await identify(requestHeaders))).locale,
        requestHeaders.get("accept-language"),
      );
    } catch (error) {
      if (!(error instanceof DomainError && error.code === "unauthenticated")) throw error;
    }
  }
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
