"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import type { Action } from "../domain/permissions";
import { operatorRoles, within, type OperatorRole } from "../domain/roles";
import { Actions, Group, Row, Switch } from "./form";
// Adding an operator by address. A person who manages a project gives a name, an address and a role, and the person
// is told by mail. The role is limited to what the one who invites holds.
const answerSchema = z.object({
  created: z.boolean(),
  mail: z.enum(["queued", "skipped", "no_connection", "paused"]),
  canSignIn: z.boolean(),
});
type Answer = z.infer<typeof answerSchema>;
const roles: OperatorRole[] = ["read", "respond", "manage"];
export function Invite({
  projects,
  held,
  locale,
  onInvited,
}: {
  projects: { id: string; name: string }[];
  held: (projectId: string) => Action[];
  locale: string;
  onInvited: () => void;
}) {
  const t = useTranslations();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OperatorRole>("read");
  const [language, setLanguage] = useState(locale === "de" ? "de" : "en");
  const [sendMail, setSendMail] = useState(true);
  const [answer, setAnswer] = useState<Answer | "error" | null>(null);
  if (projects.length === 0) return null;
  const current = projects.some((project) => project.id === projectId)
    ? projectId
    : (projects[0]?.id ?? "");
  const actions = within(operatorRoles[role], held(current));
  return (
    <form
      className="stack invite"
      onSubmit={(event) => {
        event.preventDefault();
        void (async () => {
          setAnswer(null);
          const response = await fetch(`/api/v1/projects/${current}/invitations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, email, actions, language, sendMail }),
          }).catch(() => null);
          const parsed = response?.ok ? answerSchema.safeParse(await response.json()) : null;
          if (parsed?.success) {
            setAnswer(parsed.data);
            setName("");
            setEmail("");
            onInvited();
          } else setAnswer("error");
        })();
      }}
    >
      <h3>{t("inviteTitle")}</h3>
      <p className="muted">{t("inviteHint")}</p>
      <Group>
        {projects.length > 1 && (
          <Row label={t("project")}>
            {(props) => (
              <select
                {...props}
                value={current}
                onChange={(event) => {
                  setProjectId(event.target.value);
                }}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            )}
          </Row>
        )}
        <Row label={t("name")}>
          {(props) => (
            <input
              {...props}
              value={name}
              maxLength={100}
              required
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Row>
        <Row label={t("email")}>
          {(props) => (
            <input
              {...props}
              type="email"
              value={email}
              required
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          )}
        </Row>
        <Row label={t("role")}>
          {(props) => (
            <select
              {...props}
              value={role}
              onChange={(event) => {
                setRole(event.target.value as OperatorRole);
              }}
            >
              {roles.map((option) => (
                <option key={option} value={option}>
                  {t(`role${option[0]?.toUpperCase() ?? ""}${option.slice(1)}`)}
                </option>
              ))}
            </select>
          )}
        </Row>
        <Row label={t("inviteLanguage")}>
          {(props) => (
            <select
              {...props}
              value={language}
              onChange={(event) => {
                setLanguage(event.target.value);
              }}
            >
              <option value="en">English</option>
              <option value="de">Deutsch</option>
            </select>
          )}
        </Row>
        <Switch label={t("inviteSendMail")} checked={sendMail} onChange={setSendMail} />
      </Group>
      <Actions
        status={
          answer &&
          (answer === "error" ? (
            <span className="error">{t("inviteError")}</span>
          ) : (
            <>
              <span>{t(answer.created ? "inviteCreated" : "inviteExisting")}</span>{" "}
              <span>{t(`inviteMail_${answer.mail}`)}</span>
              {!answer.canSignIn && (
                <>
                  {" "}
                  <span className="attention">{t("inviteNoProvider")}</span>
                </>
              )}
            </>
          ))
        }
      >
        <button className="primary" type="submit" disabled={actions.length === 0}>
          {t("inviteSubmit")}
        </button>
      </Actions>
    </form>
  );
}
