"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { actions as allActions, type Action } from "../domain/permissions";
import { roleOf, tokenRoles, within, type TokenRole } from "../domain/roles";
import { Actions, Group, Row, Switch } from "./form";
import { useZone } from "./time-zone";
const tokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  actions: z.array(z.enum(allActions)),
  active: z.boolean(),
  managed: z.boolean(),
  expiresAt: z.string(),
});
type Token = z.infer<typeof tokenSchema>;
const tokenLabels: Record<TokenRole | "custom", string> = {
  read: "tokenRoleRead",
  readFiles: "tokenRoleReadFiles",
  notes: "tokenRoleNotes",
  respond: "tokenRoleRespond",
  custom: "roleCustom",
};
// The service tokens of one project, and the form that issues one. An agent that aidesk runs itself has no token and
// no end date.
export function Tokens({
  projectId,
  held,
  locale,
  send,
  act,
}: {
  projectId: string;
  held: Action[];
  locale: string;
  send: (path: string, body?: object) => Promise<Response>;
  act: (request: Promise<Response>, after: () => Promise<void>) => Promise<void>;
}) {
  const t = useTranslations();
  const zone = useZone();
  const [tokens, setTokens] = useState<Token[]>([]);
  const [tokenName, setTokenName] = useState("");
  const [tokenRole, setTokenRole] = useState<TokenRole>("read");
  const [tokenDays, setTokenDays] = useState(30);
  const [tokenManaged, setTokenManaged] = useState(false);
  const [managedCreated, setManagedCreated] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const loadTokens = useCallback(async () => {
    const response = await fetch(`/api/v1/projects/${projectId}/agents`).catch(() => null);
    const parsed = response?.ok ? z.array(tokenSchema).safeParse(await response.json()) : null;
    setTokens(parsed?.success ? parsed.data : []);
  }, [projectId]);
  useEffect(() => {
    setIssued(null);
    setManagedCreated(false);
    void loadTokens();
  }, [loadTokens]);
  const fieldId = `tokens-${projectId}`;
  const setFailure = (_: "error") => {
    setFailed(true);
  };
  return (
    <section className="connections tokens" aria-labelledby={`${fieldId}-title`}>
      <h3 id={`${fieldId}-title`}>{t("tokensTitle")}</h3>
      {failed && (
        <p className="error" role="alert">
          {t("error")}
        </p>
      )}
      {tokens.length === 0 ? (
        <p className="muted">{t("noTokens")}</p>
      ) : (
        <ul className="token-list">
          {tokens.map((token) => (
            <li key={token.id}>
              <strong>{token.name}</strong>
              <span>{t(tokenLabels[roleOf(tokenRoles, token.actions)])}</span>
              <span>
                {token.active
                  ? token.managed
                    ? t("agentManagedLabel")
                    : t("tokenExpires", {
                        date: new Intl.DateTimeFormat(locale, {
                          ...zone,
                          dateStyle: "medium",
                        }).format(new Date(token.expiresAt)),
                      })
                  : t("statusRevoked")}
              </span>
              {token.active && (
                <button
                  type="button"
                  className="secondary"
                  aria-label={`${t("tokenRevoke")}: ${token.name}`}
                  onClick={() => {
                    void act(send(`/agents/${token.id}/revoke`), () => loadTokens());
                  }}
                >
                  {t("tokenRevoke")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          setIssued(null);
          setManagedCreated(false);
          void (async () => {
            if (tokenManaged) {
              const created = await send(`/projects/${projectId}/agents/managed`, {
                name: tokenName,
                actions: within(tokenRoles[tokenRole], held),
              }).catch(() => null);
              if (created?.ok) {
                setManagedCreated(true);
                setTokenName("");
              } else setFailure("error");
              await loadTokens();
              return;
            }
            const response = await send(`/projects/${projectId}/agents`, {
              name: tokenName,
              actions: within(tokenRoles[tokenRole], held),
              expiresInDays: tokenDays,
            }).catch(() => null);
            const parsed = response?.ok
              ? z.object({ token: z.string() }).safeParse(await response.json())
              : null;
            if (parsed?.success) {
              setIssued(parsed.data.token);
              setTokenName("");
            } else setFailure("error");
            await loadTokens();
          })();
        }}
      >
        <Group title={t(tokenManaged ? "managedCreate" : "tokenIssue")}>
          <Switch
            label={t("managedAgent")}
            hint={t("managedAgentHint")}
            checked={tokenManaged}
            onChange={(checked) => {
              setTokenManaged(checked);
              setIssued(null);
              setManagedCreated(false);
            }}
          />
          <Row label={t("tokenName")}>
            {(props) => (
              <input
                {...props}
                value={tokenName}
                onChange={(event) => {
                  setTokenName(event.target.value);
                }}
                required
              />
            )}
          </Row>
          <Row label={t("tokenRole")}>
            {(props) => (
              <select
                {...props}
                value={tokenRole}
                onChange={(event) => {
                  setTokenRole(event.target.value as TokenRole);
                }}
              >
                {(Object.keys(tokenRoles) as TokenRole[]).map((option) => (
                  <option key={option} value={option}>
                    {t(tokenLabels[option])}
                  </option>
                ))}
              </select>
            )}
          </Row>
          {!tokenManaged && (
            <Row label={t("tokenExpiry")}>
              {(props) => (
                <select
                  {...props}
                  value={tokenDays}
                  onChange={(event) => {
                    setTokenDays(Number(event.target.value));
                  }}
                >
                  {[7, 30, 90].map((days) => (
                    <option key={days} value={days}>
                      {t("days", { count: days })}
                    </option>
                  ))}
                </select>
              )}
            </Row>
          )}
        </Group>
        <Actions>
          <button className="primary" type="submit">
            {t(tokenManaged ? "managedCreate" : "tokenIssue")}
          </button>
        </Actions>
        {managedCreated && (
          <p className="muted" role="status">
            {t("managedCreated")}
          </p>
        )}
        {issued && (
          <div className="issued-token" role="status">
            <p>{t("tokenShownOnce")}</p>
            <code>{issued}</code>
          </div>
        )}
      </form>
    </section>
  );
}
