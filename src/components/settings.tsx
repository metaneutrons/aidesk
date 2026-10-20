"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { OwnerPasskeys } from "./owner-passkeys";
import { actions as allActions, type Action } from "../domain/permissions";
import { ProjectAgentControls, WorkspaceControls } from "./agent-controls";
import { Configuration } from "./configuration";
import { Connections } from "./connections";
import { AiProfiles } from "./ai-profiles";
import { AuditLog } from "./audit-log";
import { Limits } from "./limits";
import { ProjectLifecycle } from "./project-lifecycle";
import { PortalDomains } from "./portal-domains";
import { SsoProviders } from "./sso-providers";
import { ActionChecks, GroupsPanel } from "./groups";
import { CannedReplies } from "./canned-replies";
import { EraseRequester } from "./erase-requester";
import { Processing } from "./processing";
import { RequesterExport } from "./requester-export";
import { RoutingRules } from "./routing-rules";
import { SenderRules } from "./sender-rules";
import { TagAdmin } from "./tag-admin";
import { Invite } from "./invite";
import { PortalBranding } from "./portal-branding";
import { Profile } from "./profile";
import { UsagePanel } from "./usage";
import { Webhooks } from "./webhooks";
import { Designs } from "./designs";
import { Texts } from "./texts";
import {
  operatorRoles,
  roleOf,
  tokenRoles,
  within,
  type OperatorRole,
  type TokenRole,
} from "../domain/roles";
const action = z.enum(allActions);
const personSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  active: z.boolean(),
  owner: z.boolean(),
  signIn: z.array(z.enum(["sso", "password"])),
  grants: z.array(z.object({ projectId: z.string(), actions: z.array(action) })),
  groups: z.array(z.object({ id: z.string(), projectId: z.string(), name: z.string() })),
  effective: z.array(z.object({ projectId: z.string(), actions: z.array(action) })),
});
const tokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  actions: z.array(action),
  active: z.boolean(),
  managed: z.boolean(),
  expiresAt: z.string(),
});
type Person = z.infer<typeof personSchema>;
type Token = z.infer<typeof tokenSchema>;
interface Project {
  id: string;
  name: string;
  categories?: string[];
}
const roleLabels: Record<OperatorRole | "custom", string> = {
  none: "roleNone",
  read: "roleRead",
  respond: "roleRespond",
  manage: "roleManage",
  custom: "roleCustom",
};
const tokenLabels: Record<TokenRole | "custom", string> = {
  read: "tokenRoleRead",
  readFiles: "tokenRoleReadFiles",
  notes: "tokenRoleNotes",
  respond: "tokenRoleRespond",
  custom: "roleCustom",
};
async function send(path: string, body: object = {}): Promise<Response> {
  return fetch(`/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
export function Settings({
  viewerId,
  owner,
  projects,
  locale,
}: {
  viewerId: string;
  owner: boolean;
  projects: Project[];
  locale: string;
}) {
  const t = useTranslations();
  const fieldId = useId();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [failure, setFailure] = useState<"settingsNoAccess" | "error" | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [tokenProject, setTokenProject] = useState("");
  const [tokens, setTokens] = useState<Token[]>([]);
  const [tokenName, setTokenName] = useState("");
  const [tokenRole, setTokenRole] = useState<TokenRole>("read");
  const [tokenDays, setTokenDays] = useState(30);
  // An agent that aidesk runs itself has no token and no end date.
  const [tokenManaged, setTokenManaged] = useState(false);
  const [managedCreated, setManagedCreated] = useState(false);
  // Raised when a connection changed, so other sections that list them reload.
  const [connectionsStamp, setConnectionsStamp] = useState(0);
  const [issued, setIssued] = useState<string | null>(null);
  const load = useCallback(async () => {
    const response = await fetch("/api/v1/operators").catch(() => null);
    if (response?.status === 403) {
      setFailure("settingsNoAccess");
      return;
    }
    const parsed = response?.ok ? z.array(personSchema).safeParse(await response.json()) : null;
    if (parsed?.success) {
      setPeople(parsed.data);
      setFailure(null);
    } else setFailure("error");
  }, []);
  const managed = people?.find((person) => person.id === viewerId)?.effective ?? [];
  const held = (projectId: string): Action[] =>
    managed.find((grant) => grant.projectId === projectId)?.actions ?? [];
  const tokenProjects = managed.filter((grant) => grant.actions.includes("agent.manage"));
  const loadTokens = useCallback(async (projectId: string) => {
    if (!projectId) return;
    const response = await fetch(`/api/v1/projects/${projectId}/agents`).catch(() => null);
    const parsed = response?.ok ? z.array(tokenSchema).safeParse(await response.json()) : null;
    setTokens(parsed?.success ? parsed.data : []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadTokens(tokenProject);
  }, [tokenProject, loadTokens]);
  async function act(request: Promise<Response>, after: () => Promise<void>) {
    const response = await request.catch(() => null);
    if (!response?.ok) setFailure("error");
    await after();
  }
  const projectName = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.name ?? projectId;
  if (failure === "settingsNoAccess")
    return (
      <section className="settings">
        <p className="muted">{t("settingsNoAccess")}</p>
        <Profile />
      </section>
    );
  return (
    <section className="settings" aria-label={t("settings")}>
      {failure === "error" && (
        <p className="error" role="alert">
          {t("error")}
        </p>
      )}
      <Profile />
      <h2>{t("operatorsTitle")}</h2>
      {people === null ? (
        <p className="muted">{t("loading")}</p>
      ) : (
        <div>
          <div className="table-scroll" role="region" aria-label={t("operatorsTitle")} tabIndex={0}>
            <table className="settings-table">
              <thead>
                <tr>
                  <th scope="col">{t("name")}</th>
                  <th scope="col">{t("status")}</th>
                  {managed.map((grant) => (
                    <th scope="col" key={grant.projectId}>
                      {projectName(grant.projectId)}
                    </th>
                  ))}
                  {owner && (
                    <th scope="col">
                      <span className="visually-hidden">{t("operatorActions")}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {people.map((person) => (
                  <tr key={person.id}>
                    <td>
                      <strong>{person.name}</strong>
                      <small>{person.email}</small>
                    </td>
                    <td>
                      {t(person.active ? "statusActive" : "statusDisabled")}
                      {person.owner && ` · ${t("ownerBadge")}`}
                      {person.signIn.length > 0 &&
                        ` · ${person.signIn.map((kind) => t(kind === "sso" ? "signInSsoBadge" : "signInPasswordBadge")).join(", ")}`}
                    </td>
                    {managed.map((grant) => {
                      const current =
                        person.grants.find((entry) => entry.projectId === grant.projectId)
                          ?.actions ?? [];
                      const role = roleOf(operatorRoles, current);
                      return (
                        <td key={grant.projectId}>
                          <select
                            aria-label={`${t("role")}: ${person.name}, ${projectName(grant.projectId)}`}
                            value={role}
                            onChange={(event) => {
                              const next = event.target.value as OperatorRole;
                              void act(
                                send(`/operators/${person.id}/grants`, {
                                  projectId: grant.projectId,
                                  actions: within(operatorRoles[next], held(grant.projectId)),
                                }),
                                load,
                              );
                            }}
                          >
                            {role === "custom" && <option value="custom">{t("roleCustom")}</option>}
                            {(Object.keys(operatorRoles) as OperatorRole[]).map((option) => (
                              <option key={option} value={option}>
                                {t(roleLabels[option])}
                              </option>
                            ))}
                          </select>
                          <details className="rights">
                            <summary>
                              <span className="visually-hidden">
                                {t("rightsOf", {
                                  name: person.name,
                                  project: projectName(grant.projectId),
                                })}
                                {": "}
                              </span>
                              {t("rightsSummary")}
                            </summary>
                            <ActionChecks
                              legend={t("rightsOf", {
                                name: person.name,
                                project: projectName(grant.projectId),
                              })}
                              held={held(grant.projectId)}
                              value={current}
                              onChange={(next) => {
                                void act(
                                  send(`/operators/${person.id}/grants`, {
                                    projectId: grant.projectId,
                                    actions: next.filter((entry) =>
                                      held(grant.projectId).includes(entry),
                                    ),
                                  }),
                                  load,
                                );
                              }}
                            />
                            {person.groups.some((entry) => entry.projectId === grant.projectId) && (
                              <small className="muted">
                                {t("rightsViaGroups", {
                                  groups: person.groups
                                    .filter((entry) => entry.projectId === grant.projectId)
                                    .map((entry) => entry.name)
                                    .join(", "),
                                })}
                              </small>
                            )}
                          </details>
                        </td>
                      );
                    })}
                    {owner && (
                      <td>
                        {!person.owner && person.id !== viewerId && (
                          <button
                            type="button"
                            className="secondary"
                            aria-label={`${t(person.active ? "disable" : "enable")}: ${person.name}`}
                            onClick={() => {
                              void act(
                                send(`/operators/${person.id}/active`, { active: !person.active }),
                                load,
                              );
                            }}
                          >
                            {t(person.active ? "disable" : "enable")}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <Invite
        projects={projects.filter((project) => held(project.id).includes("project.manage"))}
        held={held}
        locale={locale}
        onInvited={() => {
          void load();
        }}
      />
      {owner && (
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(send("/operators", { name, email }), async () => {
              setName("");
              setEmail("");
              await load();
            });
          }}
        >
          <h3>{t("operatorAdd")}</h3>
          <label>
            {t("name")}
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              required
            />
          </label>
          <label>
            {t("email")}
            <input
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              required
            />
          </label>
          <p className="muted">{t("operatorAddHint")}</p>
          <button className="primary" type="submit">
            {t("operatorAdd")}
          </button>
        </form>
      )}
      {tokenProjects.length > 0 && (
        <>
          <h2>{t("tokensTitle")}</h2>
          <label className="inline-field" htmlFor={`${fieldId}-project`}>
            {t("project")}
          </label>
          <select
            id={`${fieldId}-project`}
            value={tokenProject}
            onChange={(event) => {
              setIssued(null);
              setTokenProject(event.target.value);
            }}
          >
            <option value="">–</option>
            {tokenProjects.map((grant) => (
              <option key={grant.projectId} value={grant.projectId}>
                {projectName(grant.projectId)}
              </option>
            ))}
          </select>
          {tokenProject && (
            <>
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
                            void act(send(`/agents/${token.id}/revoke`), () =>
                              loadTokens(tokenProject),
                            );
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
                className="settings-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  setIssued(null);
                  setManagedCreated(false);
                  void (async () => {
                    if (tokenManaged) {
                      const created = await send(`/projects/${tokenProject}/agents/managed`, {
                        name: tokenName,
                        actions: within(tokenRoles[tokenRole], held(tokenProject)),
                      }).catch(() => null);
                      if (created?.ok) {
                        setManagedCreated(true);
                        setTokenName("");
                      } else setFailure("error");
                      await loadTokens(tokenProject);
                      return;
                    }
                    const response = await send(`/projects/${tokenProject}/agents`, {
                      name: tokenName,
                      actions: within(tokenRoles[tokenRole], held(tokenProject)),
                      expiresInDays: tokenDays,
                    }).catch(() => null);
                    const parsed = response?.ok
                      ? z.object({ token: z.string() }).safeParse(await response.json())
                      : null;
                    if (parsed?.success) {
                      setIssued(parsed.data.token);
                      setTokenName("");
                    } else setFailure("error");
                    await loadTokens(tokenProject);
                  })();
                }}
              >
                <h3>{t(tokenManaged ? "managedCreate" : "tokenIssue")}</h3>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={tokenManaged}
                    onChange={(event) => {
                      setTokenManaged(event.target.checked);
                      setIssued(null);
                      setManagedCreated(false);
                    }}
                  />
                  <span>{t("managedAgent")}</span>
                </label>
                {tokenManaged && <p className="muted">{t("managedAgentHint")}</p>}
                <label>
                  {t("tokenName")}
                  <input
                    value={tokenName}
                    onChange={(event) => {
                      setTokenName(event.target.value);
                    }}
                    required
                  />
                </label>
                <label htmlFor={`${fieldId}-access`}>{t("tokenRole")}</label>
                <select
                  id={`${fieldId}-access`}
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
                {!tokenManaged && (
                  <>
                    <label htmlFor={`${fieldId}-expiry`}>{t("tokenExpiry")}</label>
                    <select
                      id={`${fieldId}-expiry`}
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
                  </>
                )}
                <button className="primary" type="submit">
                  {t(tokenManaged ? "managedCreate" : "tokenIssue")}
                </button>
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
            </>
          )}
        </>
      )}
      {managed
        .filter((grant) => grant.actions.includes("config.read"))
        .map((grant) => (
          <Configuration
            key={grant.projectId}
            projectId={grant.projectId}
            name={projectName(grant.projectId)}
            canWrite={grant.actions.includes("config.write")}
            canApprove={grant.actions.includes("config.approve")}
            connectionsStamp={connectionsStamp}
          />
        ))}
      {managed
        .filter((grant) => grant.actions.includes("integration.manage"))
        .map((grant) => (
          <Connections
            key={grant.projectId}
            projectId={grant.projectId}
            name={projectName(grant.projectId)}
            onChanged={() => {
              setConnectionsStamp((stamp) => stamp + 1);
            }}
          />
        ))}
      {managed
        .filter((grant) => grant.actions.includes("config.read"))
        .map((grant) => (
          <Texts
            key={grant.projectId}
            projectId={grant.projectId}
            name={projectName(grant.projectId)}
            canWrite={grant.actions.includes("config.write")}
          />
        ))}
      {managed
        .filter((grant) => grant.actions.includes("config.read"))
        .map((grant) => (
          <AiProfiles
            key={grant.projectId}
            projectId={grant.projectId}
            name={projectName(grant.projectId)}
            canWrite={grant.actions.includes("config.write")}
            canApprove={grant.actions.includes("config.approve")}
            connectionsStamp={connectionsStamp}
          />
        ))}
      {owner && <OwnerPasskeys locale={locale} />}
      {owner && <WorkspaceControls />}
      {owner && <Limits />}
      {owner && <SsoProviders />}
      {managed
        .filter((grant) => grant.actions.includes("ticket.assign"))
        .map((grant) => (
          <ProjectAgentControls
            key={grant.projectId}
            projectId={grant.projectId}
            name={projectName(grant.projectId)}
          />
        ))}
      {managed
        .filter((grant) => grant.actions.includes("integration.manage"))
        .map((grant) => (
          <Webhooks
            key={grant.projectId}
            projectId={grant.projectId}
            name={projectName(grant.projectId)}
            locale={locale}
          />
        ))}
      {managed
        .filter((grant) => grant.actions.includes("config.read"))
        .map((grant) => (
          <PortalBranding
            key={grant.projectId}
            projectId={grant.projectId}
            name={projectName(grant.projectId)}
            canWrite={grant.actions.includes("config.write")}
          />
        ))}
      {managed
        .filter((grant) => grant.actions.includes("config.read"))
        .map((grant) => (
          <UsagePanel
            key={grant.projectId}
            projectId={grant.projectId}
            name={projectName(grant.projectId)}
            locale={locale}
          />
        ))}
      {managed
        .filter((grant) => grant.actions.includes("audit.read"))
        .map((grant) => (
          <AuditLog
            key={grant.projectId}
            projectId={grant.projectId}
            name={projectName(grant.projectId)}
            locale={locale}
          />
        ))}
      {managed
        .filter((grant) => grant.actions.includes("project.manage"))
        .map((grant) => (
          <PortalDomains
            key={grant.projectId}
            projectId={grant.projectId}
            name={projectName(grant.projectId)}
          />
        ))}
      {managed
        .filter((grant) => grant.actions.includes("intake.manage"))
        .map((grant) => (
          <SenderRules
            key={grant.projectId}
            projectId={grant.projectId}
            name={projectName(grant.projectId)}
          />
        ))}
      {managed
        .filter((grant) => grant.actions.includes("config.read"))
        .map((grant) => (
          <CannedReplies
            key={grant.projectId}
            projectId={grant.projectId}
            name={projectName(grant.projectId)}
            canWrite={grant.actions.includes("config.write")}
          />
        ))}
      {managed
        .filter((grant) => grant.actions.includes("project.manage"))
        .map((grant) => (
          <RequesterExport
            key={grant.projectId}
            projectId={grant.projectId}
            name={projectName(grant.projectId)}
          />
        ))}
      {managed
        .filter((grant) => grant.actions.includes("data.erase"))
        .map((grant) => (
          <EraseRequester
            key={grant.projectId}
            projectId={grant.projectId}
            name={projectName(grant.projectId)}
          />
        ))}
      {managed
        .filter((grant) => grant.actions.includes("config.read"))
        .map((grant) => (
          <Processing
            key={grant.projectId}
            projectId={grant.projectId}
            name={projectName(grant.projectId)}
          />
        ))}
      {managed
        .filter((grant) => grant.actions.includes("intake.manage"))
        .map((grant) => (
          <RoutingRules
            key={grant.projectId}
            projectId={grant.projectId}
            name={projectName(grant.projectId)}
            categories={
              projects.find((project) => project.id === grant.projectId)?.categories ?? []
            }
          />
        ))}
      {managed
        .filter((grant) => grant.actions.includes("project.manage"))
        .map((grant) => (
          <TagAdmin
            key={grant.projectId}
            projectId={grant.projectId}
            name={projectName(grant.projectId)}
          />
        ))}
      {managed
        .filter((grant) => grant.actions.includes("project.manage"))
        .map((grant) => (
          <GroupsPanel
            key={grant.projectId}
            projectId={grant.projectId}
            name={projectName(grant.projectId)}
            held={grant.actions}
            people={(people ?? []).filter((person) => person.active)}
            onChanged={() => {
              void load();
            }}
          />
        ))}
      {owner && <PortalDomains projectId={null} name="" />}
      {owner && <AuditLog projectId={null} name="" locale={locale} />}
      <ProjectLifecycle
        manageable={projects.filter((project) => held(project.id).includes("project.manage"))}
        locale={locale}
        owner={owner}
      />
      <Designs
        projects={projects.filter((project) => held(project.id).includes("project.manage"))}
        locale={locale}
      />
    </section>
  );
}
