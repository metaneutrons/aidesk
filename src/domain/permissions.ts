export const actions = [
  "project.read",
  "project.manage",
  "ticket.read",
  "ticket.reply",
  "ticket.note",
  "ticket.assign",
  "ticket.resolve",
  "ticket.junk",
  "intake.manage",
  "integration.manage",
  "agent.manage",
  "github.publish",
  "audit.read",
] as const;
export type Action = (typeof actions)[number];
export interface Grant {
  projectId: string;
  actions: readonly Action[];
}
export interface Principal {
  id: string;
  kind: "human" | "agent";
  active: boolean;
  owner: boolean;
  grants: readonly Grant[];
}
export function permits(principal: Principal, projectId: string, action: Action): boolean {
  return (
    principal.active &&
    principal.grants.some(
      (grant) => grant.projectId === projectId && grant.actions.includes(action),
    )
  );
}
export function allowedProjectIds(principal: Principal, action: Action = "project.read"): string[] {
  return principal.active
    ? [
        ...new Set(
          principal.grants
            .filter((grant) => grant.actions.includes(action))
            .map((grant) => grant.projectId),
        ),
      ]
    : [];
}
export function isAction(value: string): value is Action {
  return actions.some((action) => action === value);
}
