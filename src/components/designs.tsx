"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { useZone } from "./time-zone";
const designSchema = z.object({
  version: z.number(),
  active: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
type Design = z.infer<typeof designSchema>;
const previewSchema = z.object({ version: z.number(), html: z.string(), text: z.string() });
const statusSchema = z.object({ status: z.string(), code: z.string().nullable() });
type Language = "en" | "de";
interface Draft {
  accent: string;
  fontFamily: "sans" | "serif" | "mono";
  headerText: string;
  logoUrl: string;
  footer: Record<Language, string>;
  signature: Record<Language, string>;
}
const emptyDraft: Draft = {
  accent: "",
  fontFamily: "sans",
  headerText: "",
  logoUrl: "",
  footer: { en: "", de: "" },
  signature: { en: "", de: "" },
};
const fonts: Draft["fontFamily"][] = ["sans", "serif", "mono"];
const languages: Language[] = ["en", "de"];
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function perLanguage(value: unknown): Record<Language, string> {
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return { en: text(record.en), de: text(record.de) };
}
// The form starts from the settings of an existing version.
function draftOf(config: Record<string, unknown>): Draft {
  const font = fonts.find((entry) => entry === config.fontFamily);
  return {
    accent: text(config.accent),
    fontFamily: font ?? "sans",
    headerText: text(config.headerText),
    logoUrl: text(config.logoUrl),
    footer: perLanguage(config.footer),
    signature: perLanguage(config.signature),
  };
}
// Empty fields are left out, so the stored version only holds what was set.
function configOf(draft: Draft): Record<string, unknown> {
  const filled = (values: Record<Language, string>) =>
    Object.fromEntries(languages.filter((l) => values[l].trim()).map((l) => [l, values[l].trim()]));
  return {
    ...(draft.accent ? { accent: draft.accent } : {}),
    fontFamily: draft.fontFamily,
    ...(draft.headerText.trim() ? { headerText: draft.headerText.trim() } : {}),
    ...(draft.logoUrl.trim() ? { logoUrl: draft.logoUrl.trim() } : {}),
    footer: filled(draft.footer),
    signature: filled(draft.signature),
  };
}
async function post(path: string, body: object): Promise<Response> {
  return fetch(`/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
export function Designs({
  projects,
  locale,
}: {
  projects: { id: string; name: string }[];
  locale: string;
}) {
  const t = useTranslations();
  const zone = useZone();
  const fieldId = useId();
  // The list of projects arrives after the first render, so the choice is
  // kept apart and falls back to the first project.
  const [chosen, setChosen] = useState("");
  const projectId = projects.some((project) => project.id === chosen)
    ? chosen
    : (projects[0]?.id ?? "");
  const [designs, setDesigns] = useState<Design[] | null>(null);
  const [failure, setFailure] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [language, setLanguage] = useState<Language>("en");
  // The version shown in the preview: 0 is the built-in design, "draft" the form.
  const [shown, setShown] = useState<number | "draft">(0);
  const [preview, setPreview] = useState<{
    version: number;
    html: string;
    text: string;
    request: number;
  } | null>(null);
  const [test, setTest] = useState<"idle" | "queued" | "sent" | "failed">("idle");
  const [testCode, setTestCode] = useState<string | null>(null);
  // Only the newest request may apply its answer.
  const previewRequest = useRef(0);
  const load = useCallback(async () => {
    if (!projectId) return;
    const response = await fetch(`/api/v1/projects/${projectId}/designs`).catch(() => null);
    const parsed = response?.ok ? z.array(designSchema).safeParse(await response.json()) : null;
    if (parsed?.success) {
      setDesigns(parsed.data);
      setFailure(false);
    } else setFailure(true);
  }, [projectId]);
  useEffect(() => {
    setDesigns(null);
    setPreview(null);
    setShown(0);
    setTest("idle");
    void load();
  }, [load]);
  const active = designs?.find((design) => design.active)?.version ?? 0;
  const render = useCallback(
    async (which: number | "draft", forLanguage: Language, current: Draft) => {
      const request = ++previewRequest.current;
      const body =
        which === "draft"
          ? { config: configOf(current), language: forLanguage }
          : { version: which, language: forLanguage };
      const response = await post(`/projects/${projectId}/designs/preview`, body).catch(() => null);
      const parsed = response?.ok ? previewSchema.safeParse(await response.json()) : null;
      if (request !== previewRequest.current) return;
      if (parsed?.success) {
        setPreview({ ...parsed.data, request });
        setFailure(false);
      } else setFailure(true);
    },
    [projectId],
  );
  useEffect(() => {
    if (!projectId || designs === null) return;
    void render(shown, language, draft);
    // The draft is previewed on request, not on every keystroke.
  }, [shown === "draft" ? 0 : shown, language, designs, render]);
  async function sendTest(version: number) {
    setTest("queued");
    setTestCode(null);
    const response = await post(`/projects/${projectId}/designs/test`, { version, language }).catch(
      () => null,
    );
    const id = response?.ok ? z.object({ id: z.string() }).safeParse(await response.json()) : null;
    if (!id?.success) {
      setTest("failed");
      setTestCode(response?.status === 429 ? "rate_limited" : "request");
      return;
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const status = await fetch(`/api/v1/test-mails/${id.data.id}`).catch(() => null);
      const parsed = status?.ok ? statusSchema.safeParse(await status.json()) : null;
      if (parsed?.success && parsed.data.status === "succeeded") {
        setTest("sent");
        return;
      }
      if (parsed?.success && parsed.data.status === "review") {
        setTest("failed");
        setTestCode(parsed.data.code ?? "unknown");
        return;
      }
    }
    setTest("failed");
    setTestCode("timeout");
  }
  if (projects.length === 0) return null;
  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, { ...zone, dateStyle: "medium", timeStyle: "short" }).format(
      new Date(value),
    );
  const label = (version: number) =>
    version === 0 ? t("designBuiltIn") : t("designVersion", { version });
  const setField = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const rows: { version: number; createdAt: string | null; config: Record<string, unknown> }[] = [
    ...(designs ?? []).map((design) => ({
      version: design.version,
      createdAt: design.createdAt,
      config: design.config,
    })),
    { version: 0, createdAt: null, config: {} },
  ];
  return (
    <section className="designs" aria-labelledby={`${fieldId}-title`}>
      <h2 id={`${fieldId}-title`}>{t("designsTitle")}</h2>
      {failure && (
        <p className="error" role="alert">
          {t("error")}
        </p>
      )}
      {projects.length > 1 && (
        <>
          <label htmlFor={`${fieldId}-project`}>{t("designProject")}</label>
          <select
            id={`${fieldId}-project`}
            value={projectId}
            onChange={(event) => {
              setChosen(event.target.value);
            }}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </>
      )}
      {designs === null ? (
        <p className="muted">{t("loading")}</p>
      ) : (
        <ul className="design-list">
          {rows.map((row) => (
            <li key={row.version}>
              <strong>{label(row.version)}</strong>
              <span>
                {row.version === active ? t("designActive") : row.createdAt && date(row.createdAt)}
              </span>
              <button
                type="button"
                className="secondary"
                aria-pressed={shown === row.version}
                aria-label={`${t("designShow")}: ${label(row.version)}`}
                onClick={() => {
                  setShown(row.version);
                }}
              >
                {t("designShow")}
              </button>
              <button
                type="button"
                className="secondary"
                aria-label={`${t("designCopy")}: ${label(row.version)}`}
                onClick={() => {
                  setDraft(draftOf(row.config));
                }}
              >
                {t("designCopy")}
              </button>
              {row.version !== active && (
                <button
                  type="button"
                  className="secondary"
                  aria-label={`${t("designSelect")}: ${label(row.version)}`}
                  onClick={() => {
                    void post(`/projects/${projectId}/designs/select`, {
                      version: row.version,
                    }).then(async (response) => {
                      if (!response.ok) setFailure(true);
                      await load();
                    });
                  }}
                >
                  {t("designSelect")}
                </button>
              )}
              <button
                type="button"
                className="secondary"
                aria-label={`${t("designTest")}: ${label(row.version)}`}
                disabled={test === "queued"}
                onClick={() => {
                  void sendTest(row.version);
                }}
              >
                {t("designTest")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {test !== "idle" && (
        <p className={test === "failed" ? "error" : "muted"} role="status">
          {test === "queued" && t("designTestQueued")}
          {test === "sent" && t("designTestSent")}
          {test === "failed" && t("designTestFailed", { code: testCode ?? "unknown" })}
        </p>
      )}
      <div className="design-preview">
        <h3>
          {t("designPreview")}
          {preview && `: ${shown === "draft" ? t("designDraft") : label(preview.version)}`}
        </h3>
        <label htmlFor={`${fieldId}-language`}>{t("designLanguage")}</label>
        <select
          id={`${fieldId}-language`}
          value={language}
          onChange={(event) => {
            setLanguage(event.target.value as Language);
          }}
        >
          {languages.map((entry) => (
            <option key={entry} value={entry}>
              {entry === "en" ? "English" : "Deutsch"}
            </option>
          ))}
        </select>
        {preview && (
          <>
            {/* A new frame for each answer: a changed srcdoc on a frame that still loads can leave it blank. */}
            <iframe
              key={preview.request}
              className="design-frame"
              title={t("designPreview")}
              sandbox=""
              srcDoc={preview.html}
            />
            <details>
              <summary>{t("designPlainText")}</summary>
              <pre>{preview.text}</pre>
            </details>
          </>
        )}
      </div>
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void post(`/projects/${projectId}/designs`, configOf(draft)).then(async (response) => {
            if (!response.ok) setFailure(true);
            await load();
          });
        }}
      >
        <h3>{t("designNew")}</h3>
        <label htmlFor={`${fieldId}-accent`}>{t("designAccent")}</label>
        <input
          id={`${fieldId}-accent`}
          value={draft.accent}
          placeholder="#5668e8"
          pattern="#[0-9a-fA-F]{6}"
          onChange={(event) => {
            setField("accent", event.target.value);
          }}
        />
        <label htmlFor={`${fieldId}-font`}>{t("designFont")}</label>
        <select
          id={`${fieldId}-font`}
          value={draft.fontFamily}
          onChange={(event) => {
            setField("fontFamily", event.target.value as Draft["fontFamily"]);
          }}
        >
          {fonts.map((font) => (
            <option key={font} value={font}>
              {t(`designFont_${font}`)}
            </option>
          ))}
        </select>
        <label htmlFor={`${fieldId}-header`}>{t("designHeader")}</label>
        <input
          id={`${fieldId}-header`}
          value={draft.headerText}
          maxLength={100}
          onChange={(event) => {
            setField("headerText", event.target.value);
          }}
        />
        <label htmlFor={`${fieldId}-logo`}>{t("designLogo")}</label>
        <input
          id={`${fieldId}-logo`}
          type="url"
          value={draft.logoUrl}
          placeholder="https://"
          onChange={(event) => {
            setField("logoUrl", event.target.value);
          }}
        />
        {languages.map((entry) => (
          <div key={entry} className="design-language">
            <label htmlFor={`${fieldId}-footer-${entry}`}>
              {t("designFooter")} ({entry === "en" ? "English" : "Deutsch"})
            </label>
            <textarea
              id={`${fieldId}-footer-${entry}`}
              value={draft.footer[entry]}
              maxLength={500}
              rows={2}
              onChange={(event) => {
                setField("footer", { ...draft.footer, [entry]: event.target.value });
              }}
            />
            <label htmlFor={`${fieldId}-signature-${entry}`}>
              {t("designSignature")} ({entry === "en" ? "English" : "Deutsch"})
            </label>
            <textarea
              id={`${fieldId}-signature-${entry}`}
              value={draft.signature[entry]}
              maxLength={1000}
              rows={3}
              onChange={(event) => {
                setField("signature", { ...draft.signature, [entry]: event.target.value });
              }}
            />
          </div>
        ))}
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setShown("draft");
            void render("draft", language, draft);
          }}
        >
          {t("designPreviewDraft")}
        </button>
        <button className="primary" type="submit">
          {t("designCreate")}
        </button>
      </form>
    </section>
  );
}
