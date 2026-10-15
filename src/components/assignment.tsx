"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Bot, UserRound } from "lucide-react";
import { z } from "zod";
import type { AiWorkState, StopLevel } from "../domain/agent-work";
// Who has a ticket, the state of the AI work on it, and what a person who may assign can do:
// hand the ticket to somebody else, or stop and resume the managed agent on this ticket.
export interface AssigneeView {
  kind: "user" | "agent";
  id: string;
  name: string;
  managed: boolean;
}
export interface AiWorkView {
  state: AiWorkState;
  reason: string | null;
  stoppedBy: StopLevel | null;
}
const assignees = z.object({
  users: z.array(z.object({ id: z.string(), name: z.string() })),
  agents: z.array(z.object({ id: z.string(), name: z.string(), managed: z.boolean() })),
});
type Choices = z.infer<typeof assignees>;
const none = "";
const keyOf = (kind: "user" | "agent", id: string) => `${kind}:${id}`;
export function Assignment({
  ticketId,
  revision,
  assignee,
  aiWork,
  canAssign,
  onChanged,
}: {
  ticketId: string;
  revision: number;
  assignee: AssigneeView | null;
  aiWork: AiWorkView | null;
  canAssign: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations();
  const [choices, setChoices] = useState<Choices | null>(null);
  const [failed, setFailed] = useState<"error" | "conflict" | null>(null);
  async function load(): Promise<void> {
    if (choices) return;
    const response = await fetch(`/api/v1/tickets/${ticketId}/assignees`).catch(() => null);
    if (!response?.ok) {
      setFailed("error");
      return;
    }
    setChoices(assignees.parse(await response.json()));
  }
  async function post(path: string, body: unknown): Promise<void> {
    setFailed(null);
    const response = await fetch(`/api/v1/tickets/${ticketId}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!response?.ok) {
      setFailed(response?.status === 409 ? "conflict" : "error");
      return;
    }
    onChanged();
  }
  function assign(value: string): Promise<void> {
    const [kind, id] = value.split(":");
    return post("assign", {
      userId: kind === "user" ? (id ?? null) : null,
      agentId: kind === "agent" ? (id ?? null) : null,
    });
  }
  const current = assignee ? keyOf(assignee.kind, assignee.id) : none;
  const Icon = assignee?.kind === "agent" ? Bot : UserRound;
  const stoppedHere = aiWork?.state === "stopped" && aiWork.stoppedBy === "ticket";
  const stoppedElsewhere = aiWork?.state === "stopped" && aiWork.stoppedBy !== "ticket";
  return (
    <div className="assignment">
      <Icon size={16} aria-hidden="true" />
      <span>
        {assignee
          ? t(assignee.managed ? "assignedToAgent" : "assignedTo", { name: assignee.name })
          : t("assigneeNone")}
      </span>
      {aiWork && (
        <span className={`ai-state ai-state-${aiWork.state}`} data-state={aiWork.state}>
          {t(`aiWork_${aiWork.state}`)}
          {stoppedElsewhere && aiWork.stoppedBy ? ` (${t(`aiStopLevel_${aiWork.stoppedBy}`)})` : ""}
        </span>
      )}
      {canAssign && (
        <label>
          <span className="visually-hidden">{t("assigneeChange")}</span>
          <select
            value={current}
            onFocus={() => {
              void load();
            }}
            onChange={(event) => {
              void assign(event.target.value);
            }}
          >
            <option value={none}>{t("assigneeNone")}</option>
            {/* The current assignee is listed before the choices are loaded. */}
            {assignee && !choices && <option value={current}>{assignee.name}</option>}
            {choices && choices.users.length > 0 && (
              <optgroup label={t("assigneePeople")}>
                {choices.users.map((person) => (
                  <option key={person.id} value={keyOf("user", person.id)}>
                    {person.name}
                  </option>
                ))}
              </optgroup>
            )}
            {choices && choices.agents.length > 0 && (
              <optgroup label={t("assigneeAgents")}>
                {choices.agents.map((agent) => (
                  <option key={agent.id} value={keyOf("agent", agent.id)}>
                    {agent.managed ? t("assigneeOptionAgent", { name: agent.name }) : agent.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
      )}
      {canAssign && assignee?.managed && !stoppedElsewhere && (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            void (stoppedHere
              ? post("resume-agent", { expectedRevision: revision })
              : post("stop-agent", {}));
          }}
        >
          {t(stoppedHere ? "agentResume" : "agentStop")}
        </button>
      )}
      {failed && (
        <small className="error" role="alert">
          {t(failed === "conflict" ? "agentConflict" : "assignError")}
        </small>
      )}
    </div>
  );
}
