"use client";
import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
// The name and the signature that the replies of the signed-in operator carry. Each person sets their own.
const profileSchema = z.object({
  name: z.string(),
  displayName: z.string().nullable(),
  signature: z.string().nullable(),
});
export function Profile() {
  const t = useTranslations();
  const titleId = useId();
  const [stored, setStored] = useState<z.infer<typeof profileSchema> | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [signature, setSignature] = useState("");
  const [message, setMessage] = useState<"saved" | "error" | null>(null);
  const show = (profile: z.infer<typeof profileSchema>) => {
    setStored(profile);
    setDisplayName(profile.displayName ?? "");
    setSignature(profile.signature ?? "");
  };
  // In development React runs the effect twice; the answer of the first run is dropped, so that it does not replace
  // what a person has begun to type.
  useEffect(() => {
    const run = { current: true };
    void (async () => {
      const response = await fetch("/api/v1/me/profile").catch(() => null);
      const parsed = response?.ok ? profileSchema.safeParse(await response.json()) : null;
      if (parsed?.success && run.current) show(parsed.data);
    })();
    return () => {
      run.current = false;
    };
  }, []);
  if (stored === null) return null;
  const changed =
    displayName.trim() !== (stored.displayName ?? "") ||
    signature.trim() !== (stored.signature ?? "");
  return (
    <section className="connections profile" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("profileTitle")}</h3>
      <p className="muted">{t("profileHint")}</p>
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            setMessage(null);
            const response = await fetch("/api/v1/me/profile", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ displayName, signature }),
            }).catch(() => null);
            const parsed = response?.ok ? profileSchema.safeParse(await response.json()) : null;
            if (parsed?.success) {
              show(parsed.data);
              setMessage("saved");
            } else setMessage("error");
          })();
        }}
      >
        <label>
          {t("profileDisplayName")}
          <input
            value={displayName}
            maxLength={100}
            placeholder={stored.name}
            onChange={(event) => {
              setDisplayName(event.target.value);
            }}
          />
        </label>
        <label>
          {t("profileSignature")}
          <textarea
            value={signature}
            maxLength={2000}
            rows={4}
            onChange={(event) => {
              setSignature(event.target.value);
            }}
          />
        </label>
        <button className="primary" type="submit" disabled={!changed}>
          {t("profileSave")}
        </button>
        {message && (
          <p className={message === "error" ? "error" : "muted"} role="status">
            {t(message === "saved" ? "profileSaved" : "profileError")}
          </p>
        )}
      </form>
    </section>
  );
}
