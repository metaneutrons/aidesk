"use client";
import { createContext, useContext, type ReactNode } from "react";
// The time zone in which the signed-in operator sees times (see the profile); none means the one of the device.
const Zone = createContext<string | null>(null);
export function TimeZone({ zone, children }: { zone: string | null; children: ReactNode }) {
  return <Zone.Provider value={zone}>{children}</Zone.Provider>;
}
// The option that puts a date into that zone, to spread into the options of `Intl.DateTimeFormat`.
export function useZone(): { timeZone?: string } {
  const zone = useContext(Zone);
  return zone ? { timeZone: zone } : {};
}
