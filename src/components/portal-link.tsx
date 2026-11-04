"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { useZone } from "./time-zone";
const grantSchema = z.object({ url: z.string(), expiresAt: z.string() });
// Gives the requester access to this one ticket. The link is shown once and
// replaces an earlier one; disabling it ends the access.
export function PortalLink({ ticketId, locale }: { ticketId: string; locale: string }) {
  const t = useTranslations();
  const zone = useZone();
  const [grant, setGrant] = useState<z.infer<typeof grantSchema> | null>(null);
  const [note, setNote] = useState<"copied" | "revoked" | "error" | null>(null);
  async function create() {
    setNote(null);
    const response = await fetch(`/api/v1/tickets/${ticketId}/portal-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => null);
    const parsed = response?.ok ? grantSchema.safeParse(await response.json()) : null;
    if (parsed?.success) setGrant(parsed.data);
    else setNote("error");
  }
  async function revoke() {
    const response = await fetch(`/api/v1/tickets/${ticketId}/portal-link/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => null);
    setGrant(null);
    setNote(response?.ok ? "revoked" : "error");
  }
  return (
    <div className="portal-link">
      {grant ? (
        <>
          <label>
            {t("portalLinkAddress")}
            <input
              readOnly
              value={grant.url}
              onFocus={(event) => {
                event.target.select();
              }}
            />
          </label>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(grant.url).then(() => {
                setNote("copied");
              });
            }}
          >
            {t("portalLinkCopy")}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void revoke();
            }}
          >
            {t("portalLinkRevoke")}
          </button>
          <small>
            {t("portalLinkNote", {
              date: new Intl.DateTimeFormat(locale, { ...zone, dateStyle: "medium" }).format(
                new Date(grant.expiresAt),
              ),
            })}
          </small>
        </>
      ) : (
        <>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void create();
            }}
          >
            {t("portalLinkCreate")}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void revoke();
            }}
          >
            {t("portalLinkRevoke")}
          </button>
        </>
      )}
      {note && (
        <small className={note === "error" ? "error" : "muted"} role="status">
          {t(
            note === "copied"
              ? "portalLinkCopied"
              : note === "revoked"
                ? "portalLinkRevoked"
                : "error",
          )}
        </small>
      )}
    </div>
  );
}
