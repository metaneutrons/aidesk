"use client";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";
// Takes out what the system holds about one requester as a file, for a request for information. The file is made
// for the request and kept nowhere; the export is an entry of the audit.
export function RequesterExport({ projectId, name }: { projectId: string; name: string }) {
  const t = useTranslations();
  const titleId = useId();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<
    "idle" | "working" | "done" | "invalid" | "tooLarge" | "error"
  >("idle");
  async function take() {
    setState("working");
    const response = await fetch(`/api/v1/projects/${projectId}/requester-export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    }).catch(() => null);
    if (!response?.ok) {
      setState(
        response?.status === 400 ? "invalid" : response?.status === 413 ? "tooLarge" : "error",
      );
      return;
    }
    const file = await response.blob();
    const filename =
      /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ??
      "requester.zip";
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    setState("done");
  }
  return (
    <section className="connections requester-export" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("requesterExportTitle", { project: name })}</h3>
      <p className="muted">{t("requesterExportHint")}</p>
      {state === "invalid" || state === "tooLarge" || state === "error" ? (
        <p className="error" role="alert">
          {t(
            state === "invalid"
              ? "eraseInvalid"
              : state === "tooLarge"
                ? "requesterExportTooLarge"
                : "error",
          )}
        </p>
      ) : null}
      {state === "done" && <p role="status">{t("requesterExportDone")}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void take();
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
              setState("idle");
            }}
          />
        </label>
        <button type="submit" disabled={email.trim() === "" || state === "working"}>
          {t(state === "working" ? "requesterExportWorking" : "requesterExportButton")}
        </button>
      </form>
    </section>
  );
}
