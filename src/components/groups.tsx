"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { actions as allActions, type Action } from "../domain/permissions";
import { operatorRoles, roleOf, within } from "../domain/roles";
// Single actions and groups. A person who manages a project picks the actions of an operator one by one, and forms
// groups whose actions every member holds. Nobody gives more than they hold: an action that the caller does not hold
// is shown, and cannot be ticked.
const actionSchema = z.enum(allActions);
const groupSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  actions: z.array(actionSchema),
  members: z.array(
    z.object({ id: z.string(), name: z.string(), email: z.string(), active: z.boolean() }),
  ),
});
type Group = z.infer<typeof groupSchema>;
export interface Candidate {
  id: string;
  name: string;
  email: string;
}
// The key of the text of an action: `ticket.read_files` is `actionTicketReadFiles`.
export const actionKey = (value: Action) =>
  `action${value.replace(/(^|[._])(\w)/g, (_, __, letter: string) => letter.toUpperCase())}`;
export function ActionChecks({
  legend,
  held,
  value,
  onChange,
  disabled = false,
}: {
  legend: string;
  held: readonly Action[];
  value: readonly Action[];
  onChange: (next: Action[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations();
  return (
    <fieldset className="action-checks" disabled={disabled}>
      <legend>{legend}</legend>
      {allActions.map((entry) => (
        <label key={entry} className="check">
          <input
            type="checkbox"
            checked={value.includes(entry)}
            disabled={!held.includes(entry) && !value.includes(entry)}
            onChange={(event) => {
              onChange(
                event.target.checked
                  ? [...value, entry]
                  : value.filter((action) => action !== entry),
              );
            }}
          />
          <span>{t(actionKey(entry))}</span>
        </label>
      ))}
    </fieldset>
  );
}
async function post(path: string, body: object = {}) {
  return fetch(`/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
}
export function GroupsPanel({
  projectId,
  name,
  held,
  people,
  onChanged,
}: {
  projectId: string;
  name: string;
  held: readonly Action[];
  people: Candidate[];
  onChanged: () => void;
}) {
  const t = useTranslations();
  const titleId = useId();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [newName, setNewName] = useState("");
  const [newActions, setNewActions] = useState<Action[]>(within(operatorRoles.read, held));
  const [edited, setEdited] = useState<Record<string, Action[]>>({});
  const [adding, setAdding] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(
    async (current: () => boolean = () => true) => {
      const response = await fetch(`/api/v1/projects/${projectId}/groups`).catch(() => null);
      const parsed = response?.ok ? z.array(groupSchema).safeParse(await response.json()) : null;
      if (parsed?.success && current()) {
        setGroups(parsed.data);
        setEdited({});
      }
    },
    [projectId],
  );
  // In development React runs the effect twice; the answer of the first run is dropped, so that it does not clear
  // what a person has begun to tick.
  useEffect(() => {
    let current = true;
    void load(() => current);
    return () => {
      current = false;
    };
  }, [load]);
  async function act(request: Promise<Response | null>) {
    const response = await request;
    setFailed(!response?.ok);
    await load();
    onChanged();
  }
  if (groups === null) return null;
  const mayChange = (group: Group) => group.actions.every((action) => held.includes(action));
  const roleName = (granted: readonly Action[]) => {
    const role = roleOf(operatorRoles, granted);
    return role === "custom"
      ? t("roleCustom")
      : t(`role${role[0]?.toUpperCase() ?? ""}${role.slice(1)}`);
  };
  return (
    <section className="connections groups" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("groupsTitle", { project: name })}</h3>
      <p className="muted">{t("groupsHint")}</p>
      {failed && (
        <p className="error" role="alert">
          {t("error")}
        </p>
      )}
      {groups.length === 0 ? (
        <p className="muted">{t("groupsNone")}</p>
      ) : (
        <ul className="connection-list">
          {groups.map((group) => {
            const open = mayChange(group);
            const draft = edited[group.id] ?? group.actions;
            const addable = people.filter(
              (person) => !group.members.some((member) => member.id === person.id),
            );
            return (
              <li key={group.id}>
                <span>
                  <strong>{group.name}</strong>{" "}
                  <span className="muted">
                    {roleName(group.actions)} · {t("groupMembers", { count: group.members.length })}
                  </span>
                </span>
                {!open && <small className="muted">{t("groupAboveYou")}</small>}
                <ul className="group-members">
                  {group.members.map((member) => (
                    <li key={member.id}>
                      <span>{member.name}</span>
                      <button
                        type="button"
                        className="secondary"
                        disabled={!open}
                        aria-label={t("groupRemoveMember", {
                          name: member.name,
                          group: group.name,
                        })}
                        onClick={() => {
                          void act(
                            post(`/projects/${projectId}/groups/${group.id}/members`, {
                              userId: member.id,
                              member: false,
                            }),
                          );
                        }}
                      >
                        {t("groupRemove")}
                      </button>
                    </li>
                  ))}
                </ul>
                {open && addable.length > 0 && (
                  <form
                    className="group-add"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const userId = adding[group.id];
                      if (userId)
                        void act(
                          post(`/projects/${projectId}/groups/${group.id}/members`, {
                            userId,
                            member: true,
                          }),
                        ).then(() => {
                          setAdding({ ...adding, [group.id]: "" });
                        });
                    }}
                  >
                    <label>
                      <span className="visually-hidden">
                        {t("groupAddMember", { group: group.name })}
                      </span>
                      <select
                        value={adding[group.id] ?? ""}
                        aria-label={t("groupAddMember", { group: group.name })}
                        onChange={(event) => {
                          setAdding({ ...adding, [group.id]: event.target.value });
                        }}
                      >
                        <option value="">–</option>
                        {addable.map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="submit" className="secondary" disabled={!adding[group.id]}>
                      {t("groupAdd")}
                    </button>
                  </form>
                )}
                {open && (
                  <details className="group-rights">
                    <summary>{t("groupRights", { group: group.name })}</summary>
                    <ActionChecks
                      legend={t("groupRightsLegend", { group: group.name })}
                      held={held}
                      value={draft}
                      onChange={(next) => {
                        setEdited({ ...edited, [group.id]: next });
                      }}
                    />
                    <button
                      type="button"
                      className="secondary"
                      disabled={draft.join() === group.actions.join()}
                      onClick={() => {
                        void act(
                          post(`/projects/${projectId}/groups/${group.id}`, { actions: draft }),
                        );
                      }}
                    >
                      {t("groupRightsSave", { group: group.name })}
                    </button>
                  </details>
                )}
                {open &&
                  (confirming === group.id ? (
                    <span className="connection-actions">
                      <span className="attention">{t("groupDeleteAsk")}</span>
                      <button
                        type="button"
                        className="secondary danger"
                        onClick={() => {
                          setConfirming(null);
                          void act(post(`/projects/${projectId}/groups/${group.id}/delete`));
                        }}
                      >
                        {t("groupDeleteConfirm", { group: group.name })}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setConfirming(null);
                        }}
                      >
                        {t("groupDeleteCancel")}
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setConfirming(group.id);
                      }}
                    >
                      {t("groupDelete", { group: group.name })}
                    </button>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void act(
            post(`/projects/${projectId}/groups`, { name: newName, actions: newActions }),
          ).then(() => {
            setNewName("");
          });
        }}
      >
        <h4>{t("groupCreate")}</h4>
        <label>
          {t("groupName")}
          <input
            value={newName}
            maxLength={60}
            required
            onChange={(event) => {
              setNewName(event.target.value);
            }}
          />
        </label>
        <ActionChecks
          legend={t("groupActionsLegend")}
          held={held}
          value={newActions}
          onChange={setNewActions}
        />
        <button className="primary" type="submit" disabled={newName.trim() === ""}>
          {t("groupCreate")}
        </button>
      </form>
    </section>
  );
}
