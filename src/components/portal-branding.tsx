"use client";
import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { Actions, Group, Row } from "./form";
import { logoMaxBytes } from "../domain/branding";
// How the customer page of a project looks: its name, a line of text, the colour of the buttons, the language and
// the logo. What is left empty is not shown, and the page looks as it did before.
const brandingSchema = z.object({
  displayName: z.string().nullable(),
  headerText: z.string().nullable(),
  accentColor: z.string().nullable(),
  language: z.enum(["en", "de"]).nullable(),
  hasLogo: z.boolean(),
  updatedAt: z.string().nullable(),
});
type Branding = z.infer<typeof brandingSchema>;
type Message = "saved" | "logoSaved" | "logoRemoved" | "logoTooLarge" | "logoType" | "error";
const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};
export function PortalBranding({
  projectId,
  name,
  canWrite,
}: {
  projectId: string;
  name: string;
  canWrite: boolean;
}) {
  const t = useTranslations();
  const titleId = useId();
  const [stored, setStored] = useState<Branding | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [headerText, setHeaderText] = useState("");
  const [accent, setAccent] = useState("");
  const [language, setLanguage] = useState("");
  const [message, setMessage] = useState<Message | null>(null);
  const [logoVersion, setLogoVersion] = useState(0);
  const show = (branding: Branding) => {
    setStored(branding);
    setDisplayName(branding.displayName ?? "");
    setHeaderText(branding.headerText ?? "");
    setAccent(branding.accentColor ?? "");
    setLanguage(branding.language ?? "");
  };
  // In development React runs the effect twice; the answer of the first run is dropped, so that it does not replace
  // what a person has begun to type.
  useEffect(() => {
    const run = { current: true };
    void (async () => {
      const response = await fetch(`/api/v1/projects/${projectId}/portal-branding`).catch(
        () => null,
      );
      const parsed = response?.ok ? brandingSchema.safeParse(await response.json()) : null;
      if (parsed?.success && run.current) show(parsed.data);
    })();
    return () => {
      run.current = false;
    };
  }, [projectId]);
  if (stored === null) return null;
  const colourValid = accent === "" || /^#[0-9a-fA-F]{6}$/.test(accent);
  const changed =
    displayName.trim() !== (stored.displayName ?? "") ||
    headerText.trim() !== (stored.headerText ?? "") ||
    accent.trim().toLowerCase() !== (stored.accentColor ?? "") ||
    language !== (stored.language ?? "");
  async function save() {
    setMessage(null);
    const response = await fetch(`/api/v1/projects/${projectId}/portal-branding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName,
        headerText,
        accentColor: accent === "" ? null : accent,
        language: language === "" ? null : language,
      }),
    }).catch(() => null);
    const parsed = response?.ok ? brandingSchema.safeParse(await response.json()) : null;
    if (parsed?.success) {
      show(parsed.data);
      setMessage("saved");
    } else setMessage("error");
  }
  async function upload(file: File) {
    setMessage(null);
    if (file.size > logoMaxBytes) {
      setMessage("logoTooLarge");
      return;
    }
    const data = toBase64(new Uint8Array(await file.arrayBuffer()));
    const response = await fetch(`/api/v1/projects/${projectId}/portal-branding/logo`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
    }).catch(() => null);
    const parsed = response?.ok ? brandingSchema.safeParse(await response.json()) : null;
    if (parsed?.success) {
      setStored(parsed.data);
      setLogoVersion((version) => version + 1);
      setMessage("logoSaved");
    } else
      setMessage(
        response?.status === 415 ? "logoType" : response?.status === 413 ? "logoTooLarge" : "error",
      );
  }
  async function remove() {
    setMessage(null);
    const response = await fetch(`/api/v1/projects/${projectId}/portal-branding/logo/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => null);
    const parsed = response?.ok ? brandingSchema.safeParse(await response.json()) : null;
    if (parsed?.success) {
      setStored(parsed.data);
      setMessage("logoRemoved");
    } else setMessage("error");
  }
  return (
    <section className="connections portal-branding" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("brandingTitle", { project: name })}</h3>
      <p className="muted">{t("brandingHint")}</p>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="plain" disabled={!canWrite}>
          <Group>
            <Row label={t("brandingName")}>
              {(props) => (
                <input
                  {...props}
                  value={displayName}
                  maxLength={80}
                  onChange={(event) => {
                    setDisplayName(event.target.value);
                  }}
                />
              )}
            </Row>
            <Row label={t("brandingHeader")}>
              {(props) => (
                <input
                  {...props}
                  value={headerText}
                  maxLength={300}
                  onChange={(event) => {
                    setHeaderText(event.target.value);
                  }}
                />
              )}
            </Row>
            <Row label={t("brandingColor")}>
              {(props) => (
                <span className="color-field">
                  <input
                    type="color"
                    value={/^#[0-9a-fA-F]{6}$/.test(accent) ? accent : "#5167ed"}
                    aria-label={t("brandingColorPick")}
                    onChange={(event) => {
                      setAccent(event.target.value);
                    }}
                  />
                  <input
                    {...props}
                    value={accent}
                    placeholder="#5167ed"
                    maxLength={7}
                    aria-invalid={!colourValid}
                    onChange={(event) => {
                      setAccent(event.target.value);
                    }}
                  />
                </span>
              )}
            </Row>
            <Row label={t("brandingLanguage")}>
              {(props) => (
                <select
                  {...props}
                  value={language}
                  onChange={(event) => {
                    setLanguage(event.target.value);
                  }}
                >
                  <option value="">{t("brandingLanguageAuto")}</option>
                  <option value="en">English</option>
                  <option value="de">Deutsch</option>
                </select>
              )}
            </Row>
          </Group>
          <Actions
            status={
              message && (
                <span className={message === "error" ? "error" : undefined}>
                  {t(`brandingMessage_${message}`)}
                </span>
              )
            }
          >
            <button className="primary" type="submit" disabled={!changed || !colourValid}>
              {t("brandingSave")}
            </button>
          </Actions>
        </fieldset>
      </form>
      <Group title={t("brandingLogo")}>
        <div className="row">
          <div className="row-label">
            {stored.hasLogo ? (
              <img
                src={`/api/v1/projects/${projectId}/portal-branding/logo?v=${String(logoVersion)}`}
                alt={t("brandingLogoAlt", { project: name })}
                height={48}
              />
            ) : (
              <span className="muted">{t("brandingLogoNone")}</span>
            )}
          </div>
          {canWrite && (
            <div className="row-control">
              {stored.hasLogo && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    void remove();
                  }}
                >
                  {t("brandingLogoRemove")}
                </button>
              )}
            </div>
          )}
        </div>
        {canWrite && (
          <Row label={t("brandingLogoUpload")}>
            {(props) => (
              <input
                {...props}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                  event.target.value = "";
                }}
              />
            )}
          </Row>
        )}
      </Group>
    </section>
  );
}
