"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { erasurePreview } from "../domain/erasure";
import { ErasureSummary } from "./erasure-summary";
// Erases the open ticket after showing what goes. The numbers that were shown are sent back with the request, so a
// ticket that changed meanwhile is not erased unseen.
export function EraseTicket({ ticketId, onErased }: { ticketId: string; onErased: () => void }) {
  const t = useTranslations();
  const [preview, setPreview] = useState<z.infer<typeof erasurePreview> | null>(null);
  const [problem, setProblem] = useState<"stale" | "error" | null>(null);
  async function open() {
    setProblem(null);
    const response = await fetch(`/api/v1/tickets/${ticketId}/erasure`).catch(() => null);
    const parsed = response?.ok ? erasurePreview.safeParse(await response.json()) : null;
    if (parsed?.success) setPreview(parsed.data);
    else setProblem("error");
  }
  async function erase() {
    if (!preview) return;
    const response = await fetch(`/api/v1/tickets/${ticketId}/erase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected: preview.counts }),
    }).catch(() => null);
    if (response?.ok) {
      setPreview(null);
      onErased();
      return;
    }
    setProblem(response?.status === 409 ? "stale" : "error");
    if (response?.status === 409) await open();
  }
  if (!preview)
    return (
      <div className="erase-ticket">
        <button type="button" className="secondary" onClick={() => void open()}>
          {t("eraseTicketButton")}
        </button>
        {problem === "error" && (
          <span className="error" role="alert">
            {t("error")}
          </span>
        )}
      </div>
    );
  return (
    <div className="erase-ticket" role="group" aria-label={t("eraseTicketGroup")}>
      <ErasureSummary counts={preview.counts} reach={preview.outOfReach} />
      {problem === "stale" && (
        <p className="error" role="alert">
          {t("eraseStale")}
        </p>
      )}
      <button type="button" className="danger" onClick={() => void erase()}>
        {t("eraseConfirm")}
      </button>
      <button
        type="button"
        className="secondary"
        onClick={() => {
          setPreview(null);
          setProblem(null);
        }}
      >
        {t("eraseCancel")}
      </button>
    </div>
  );
}
