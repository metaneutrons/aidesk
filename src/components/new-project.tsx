"use client";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
// A new project, for the owner: the topic "Projects" of the settings offers it, because a project is made rarely and the
// settings are where projects are managed. The dialog keeps its own state, so that its error is not the one of a reply
// that is being written elsewhere.
export function NewProject({
  locale,
  onCreated,
}: {
  // The language the project starts with: the one the owner reads the desk in.
  locale: string;
  // Called when the project exists, so that what lists the projects asks again.
  onCreated: () => void;
}) {
  const t = useTranslations();
  const router = useRouter();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  // Closing, by any way, leaves nothing of what was typed or of a message for the next time.
  function close(): void {
    setOpen(false);
    setFailed(false);
    setName("");
    setSlug("");
  }
  async function create(): Promise<void> {
    setSending(true);
    setFailed(false);
    try {
      const response = await fetch("/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, slug, defaultLanguage: locale }),
      });
      if (!response.ok) throw new Error("create_failed");
      close();
      router.refresh();
      onCreated();
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  }
  return (
    <section className="connections new-project" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("projectsNewTitle")}</h3>
      <p className="muted">{t("projectsNewHint")}</p>
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (next) setOpen(true);
          else close();
        }}
      >
        <div>
          <Dialog.Trigger className="primary">{t("newProject")}</Dialog.Trigger>
        </div>
        <Dialog.Portal>
          <Dialog.Backdrop className="modal-backdrop" />
          <Dialog.Popup className="modal">
            <button
              type="button"
              className="icon-button modal-close"
              aria-label={t("close")}
              onClick={close}
            >
              <X size={18} />
            </button>
            <Dialog.Title render={<h2 />}>{t("newProject")}</Dialog.Title>
            <Dialog.Description className="muted">{t("newProjectDescription")}</Dialog.Description>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <label>
                {t("projectName")}
                <input
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                  required
                  maxLength={100}
                />
              </label>
              <label>
                {t("projectSlug")}
                <input
                  value={slug}
                  onChange={(event) => {
                    setSlug(event.target.value);
                  }}
                  required
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  maxLength={60}
                />
              </label>
              {failed && (
                <p className="error" role="alert">
                  {t("error")}
                </p>
              )}
              <div className="modal-actions">
                <button className="secondary" type="button" onClick={close}>
                  {t("cancel")}
                </button>
                <button className="primary" disabled={sending}>
                  {t("create")}
                </button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
