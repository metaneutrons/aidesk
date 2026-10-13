"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog } from "@base-ui/react/dialog";
import { z } from "zod";
const previewSchema = z.object({
  subject: z.string(),
  from: z.string(),
  date: z.string().nullable(),
  html: z.string(),
  text: z.string(),
  remoteImagesBlocked: z.number(),
});
type Preview = z.infer<typeof previewSchema>;
// The received original of a message as a safe view. The formatted view is a
// frame without scripts and with its own policy; the plain text is the
// fallback. The dialog returns focus to its button and closes with Escape.
export function OriginalPreview({ messageId, locale }: { messageId: string; locale: string }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<"formatted" | "text">("formatted");
  useEffect(() => {
    if (!open) return;
    setFailed(false);
    const request = { current: true };
    void (async () => {
      const response = await fetch(`/api/v1/messages/${messageId}/original/preview`).catch(
        () => null,
      );
      const parsed = response?.ok ? previewSchema.safeParse(await response.json()) : null;
      if (!request.current) return;
      if (parsed?.success) setPreview(parsed.data);
      else setFailed(true);
    })();
    return () => {
      request.current = false;
    };
  }, [open, messageId]);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="secondary small">{t("originalPreview")}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Popup className="modal original-modal">
          <Dialog.Title render={<h2 />}>{t("originalPreview")}</Dialog.Title>
          {preview && (
            <Dialog.Description className="muted">
              {preview.subject}
              {preview.from && ` · ${t("originalFrom")}: ${preview.from}`}
              {preview.date &&
                ` · ${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(preview.date))}`}
            </Dialog.Description>
          )}
          {failed && (
            <p className="error" role="alert">
              {t("originalPreviewError")}
            </p>
          )}
          {preview && (
            <>
              <div className="original-tabs" role="group" aria-label={t("originalPreview")}>
                {(["formatted", "text"] as const).map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    className="secondary small"
                    aria-pressed={view === entry}
                    onClick={() => {
                      setView(entry);
                    }}
                  >
                    {t(entry === "formatted" ? "originalFormatted" : "originalText")}
                  </button>
                ))}
              </div>
              {preview.remoteImagesBlocked > 0 && (
                <p className="muted">
                  {t("originalImagesBlocked", { count: preview.remoteImagesBlocked })}
                </p>
              )}
              {view === "formatted" ? (
                <iframe
                  className="original-frame"
                  title={t("originalFormatted")}
                  sandbox=""
                  srcDoc={preview.html}
                />
              ) : (
                <pre className="original-text">{preview.text}</pre>
              )}
            </>
          )}
          <div className="modal-actions">
            <Dialog.Close className="secondary">{t("close")}</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
