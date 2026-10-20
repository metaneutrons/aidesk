"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
// The keys of the installation: what still depends on the previous encryption key and the previous secret, and the
// button that re-protects it. The operator sets the keys in the environment; this page only reports and runs the job.
const groupSchema = z.object({
  name: z.string(),
  key: z.enum(["encryption", "auth"]),
  total: z.number(),
  current: z.number(),
  previous: z.number(),
  unreadable: z.number(),
});
const statusSchema = z.object({
  encryptionPrevious: z.boolean(),
  authPrevious: z.boolean(),
  authVersion: z.number(),
  groups: z.array(groupSchema),
  settled: z.boolean(),
});
export function KeyRotation() {
  const t = useTranslations();
  const titleId = useId();
  const [status, setStatus] = useState<z.infer<typeof statusSchema> | null>(null);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState(false);
  const load = useCallback(async (current: () => boolean = () => true) => {
    const response = await fetch("/api/v1/workspace/keys").catch(() => null);
    const parsed = response?.ok ? statusSchema.safeParse(await response.json()) : null;
    if (parsed?.success && current()) setStatus(parsed.data);
  }, []);
  useEffect(() => {
    const run = { current: true };
    void load(() => run.current);
    return () => {
      run.current = false;
    };
  }, [load]);
  if (status === null) return null;
  const rotating = status.encryptionPrevious || status.authPrevious || !status.settled;
  async function rotate() {
    setRunning(true);
    setProblem(false);
    const response = await fetch("/api/v1/workspace/keys/rotate", { method: "POST" }).catch(
      () => null,
    );
    const parsed = response?.ok ? statusSchema.safeParse(await response.json()) : null;
    if (parsed?.success) setStatus(parsed.data);
    else setProblem(true);
    setRunning(false);
  }
  return (
    <section className="connections key-rotation" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("keysTitle")}</h3>
      <p className="muted">{t("keysHint")}</p>
      <p role="status">
        {rotating ? t("keysRotating") : t("keysNone")}{" "}
        {rotating && (status.settled ? t("keysSettled") : t("keysOpen"))}
      </p>
      {problem && (
        <p className="error" role="alert">
          {t("error")}
        </p>
      )}
      <ul className="connection-list">
        {status.groups.map((group) => (
          <li key={group.name}>
            <span>{t(`keysGroup_${group.name}`)}</span>
            <span className="muted">
              {t("keysCounts", {
                total: group.total,
                previous: group.previous,
                unreadable: group.unreadable,
              })}
            </span>
          </li>
        ))}
      </ul>
      <button type="button" disabled={!rotating || running} onClick={() => void rotate()}>
        {t(running ? "keysWorking" : "keysRun")}
      </button>
    </section>
  );
}
