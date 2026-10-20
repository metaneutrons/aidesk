"use client";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { erasurePreview, erasureResult } from "../domain/erasure";
import { ErasureSummary } from "./erasure-summary";
// Erases everything about one requester in a project: asks for the address, shows what goes, and sends the numbers
// back with the confirmation.
export function EraseRequester({ projectId, name }: { projectId: string; name: string }) {
  const t = useTranslations();
  const titleId = useId();
  const [email, setEmail] = useState("");
  const [preview, setPreview] = useState<{
    email: string;
    data: z.infer<typeof erasurePreview>;
  } | null>(null);
  const [done, setDone] = useState<z.infer<typeof erasureResult> | null>(null);
  const [problem, setProblem] = useState<"stale" | "invalid" | "error" | null>(null);
  async function show() {
    setProblem(null);
    setDone(null);
    const response = await fetch(
      `/api/v1/projects/${projectId}/erasure/requester?email=${encodeURIComponent(email.trim())}`,
    ).catch(() => null);
    const parsed = response?.ok ? erasurePreview.safeParse(await response.json()) : null;
    if (parsed?.success) setPreview({ email: email.trim().toLowerCase(), data: parsed.data });
    else {
      setPreview(null);
      setProblem(response?.status === 400 ? "invalid" : "error");
    }
  }
  async function erase() {
    if (!preview) return;
    const response = await fetch(`/api/v1/projects/${projectId}/erasure/requester`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: preview.email, expected: preview.data.counts }),
    }).catch(() => null);
    if (response?.ok) {
      const parsed = erasureResult.safeParse(await response.json());
      setDone(parsed.success ? parsed.data : null);
      setPreview(null);
      setEmail("");
      return;
    }
    setProblem(response?.status === 409 ? "stale" : "error");
    if (response?.status === 409) await show();
  }
  const problemText = { stale: "eraseStale", invalid: "eraseInvalid", error: "error" } as const;
  return (
    <section className="connections erase-requester" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("eraseRequesterTitle", { project: name })}</h3>
      <p className="muted">{t("eraseRequesterHint")}</p>
      {problem && (
        <p className="error" role="alert">
          {t(problemText[problem])}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void show();
        }}
      >
        <label>
          {t("eraseRequesterAddress")}
          <input
            type="email"
            value={email}
            maxLength={320}
            onChange={(event) => {
              setEmail(event.target.value);
              setPreview(null);
            }}
          />
        </label>
        <button type="submit" className="secondary" disabled={email.trim() === ""}>
          {t("eraseRequesterShow")}
        </button>
      </form>
      {preview && (
        <div role="group" aria-label={t("eraseRequesterGroup", { email: preview.email })}>
          <ErasureSummary counts={preview.data.counts} reach={preview.data.outOfReach} />
          {preview.data.tickets.length > 0 && (
            <ul>
              {preview.data.tickets.map((ticket) => (
                <li key={ticket.id}>
                  #{ticket.number ?? ""} {ticket.subject}
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="danger"
            disabled={
              preview.data.counts.tickets === 0 &&
              preview.data.counts.ingress === 0 &&
              preview.data.counts.portalRecords === 0
            }
            onClick={() => void erase()}
          >
            {t("eraseConfirm")}
          </button>
        </div>
      )}
      {done && (
        <p role="status">
          {t("eraseDone", { tickets: done.counts.tickets, messages: done.counts.messages })}
        </p>
      )}
    </section>
  );
}
