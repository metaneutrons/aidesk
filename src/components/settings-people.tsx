"use client";
import { useTranslations } from "next-intl";
import type { Action } from "../domain/permissions";
import { ActionChecks } from "./groups";
import { Actions, Group, Row } from "./form";
import { Invite } from "./invite";
import { operatorRoles, roleOf, within, type OperatorRole } from "../domain/roles";
import { useState } from "react";
export interface Person {
  id: string;
  name: string;
  email: string;
  active: boolean;
  owner: boolean;
  signIn: ("sso" | "password")[];
  grants: { projectId: string; actions: Action[] }[];
  groups: { id: string; projectId: string; name: string }[];
  effective: { projectId: string; actions: Action[] }[];
}
const roleLabels: Record<OperatorRole | "custom", string> = {
  none: "roleNone",
  read: "roleRead",
  respond: "roleRespond",
  manage: "roleManage",
  custom: "roleCustom",
};
// The operators of the installation with their role in each project that the viewer manages, the invitation of a
// person and, for the owner, the addition of an operator by hand.
export function People({
  people,
  managed,
  owner,
  viewerId,
  projects,
  locale,
  projectName,
  held,
  send,
  act,
  load,
}: {
  people: Person[] | null;
  managed: { projectId: string; actions: Action[] }[];
  owner: boolean;
  viewerId: string;
  projects: { id: string; name: string }[];
  locale: string;
  projectName: (projectId: string) => string;
  held: (projectId: string) => Action[];
  send: (path: string, body?: object) => Promise<Response>;
  act: (request: Promise<Response>, after: () => Promise<void>) => Promise<void>;
  load: () => Promise<void>;
}) {
  const t = useTranslations();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  return (
    <>
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
          className="stack"
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
          <Group note={t("operatorAddHint")}>
            <Row label={t("name")}>
              {(props) => (
                <input
                  {...props}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                  required
                />
              )}
            </Row>
            <Row label={t("email")}>
              {(props) => (
                <input
                  {...props}
                  type="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                  }}
                  required
                />
              )}
            </Row>
          </Group>
          <Actions>
            <button className="primary" type="submit">
              {t("operatorAdd")}
            </button>
          </Actions>
        </form>
      )}
    </>
  );
}
