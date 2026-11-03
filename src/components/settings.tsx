"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  Archive,
  Bell,
  Bot,
  ChartColumn,
  Database,
  Globe,
  KeyRound,
  Lock,
  LogIn,
  MailPlus,
  MessageSquareText,
  PanelsTopLeft,
  Palette,
  Plug,
  ScrollText,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Type,
  User,
  Users,
  UsersRound,
  Webhook,
} from "lucide-react";
import { z } from "zod";
import { NewProject } from "./new-project";
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
import { GroupsPanel } from "./groups";
import { CannedReplies } from "./canned-replies";
import { KeyRotation } from "./key-rotation";
import { EraseRequester } from "./erase-requester";
import { Processing } from "./processing";
import { RequesterExport } from "./requester-export";
import { RoutingRules } from "./routing-rules";
import { SenderRules } from "./sender-rules";
import { TagAdmin } from "./tag-admin";
import { PortalBranding } from "./portal-branding";
import { Profile } from "./profile";
import { NotificationPreferences } from "./notification-preferences";
import { SignIn } from "./sign-in";
import { UsagePanel } from "./usage";
import { Webhooks } from "./webhooks";
import { Designs } from "./designs";
import { Texts } from "./texts";
import { People, type Person } from "./settings-people";
import { SettingsShell, type Topic, type TopicGroup } from "./settings-shell";
import { Tokens } from "./settings-tokens";
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
interface Project {
  id: string;
  name: string;
  categories?: string[];
}
async function send(path: string, body: object = {}): Promise<Response> {
  return fetch(`/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
// A topic of the project group is shown when the viewer holds one of these actions in the chosen project.
const projectTopics = [
  ["general", Settings2, ["config.read"]],
  ["connections", Plug, ["integration.manage"]],
  ["intake", MailPlus, ["intake.manage"]],
  ["texts", Type, ["config.read"]],
  ["ai", Sparkles, ["config.read"]],
  ["agents", Bot, ["ticket.assign", "agent.manage"]],
  ["portal", PanelsTopLeft, ["config.read", "project.manage"]],
  ["replies", MessageSquareText, ["config.read", "project.manage"]],
  ["groups", UsersRound, ["project.manage"]],
  ["webhooks", Webhook, ["integration.manage"]],
  ["data", Database, ["config.read", "data.export", "data.erase"]],
  ["usage", ChartColumn, ["config.read"]],
  ["audit", ScrollText, ["audit.read"]],
] as const satisfies readonly (readonly [string, Topic["icon"], readonly Action[]])[];
const projectTopicIds = new Set<string>(projectTopics.map(([id]) => id));
const label = (id: string) =>
  `topic${id.replace(/(^|-)(\w)/g, (_, __, letter: string) => letter.toUpperCase())}`;
// The topics of the account (the profile, the notifications and the sign-in of the person) are behind the entry of the
// person at the bottom of the menu; the others are the settings of the workspace and of the projects. `account` is the
// address of the list of the account topics, as an empty value is the list of the other settings.
export type SettingsArea = "account" | "workspace";
const accountTopicIds = new Set(["profile", "notifications", "security", "account"]);
export const areaOf = (topic: string | null): SettingsArea =>
  topic !== null && accountTopicIds.has(topic) ? "account" : "workspace";
// The address of a topic: the settings are part of the desk, so the address is the desk's with the topic in the query.
function address(topic: string | null, project: string | null, area: SettingsArea): string {
  const query = new URLSearchParams({ settings: topic ?? (area === "account" ? "account" : "") });
  if (topic && project && projectTopicIds.has(topic)) query.set("project", project);
  return `/?${query.toString()}`;
}
// The address is changed without telling the router of the framework (which takes a state of its own as a sign
// that the change is none of its business): its request for fresh data, as after a change of the profile, keeps
// asking for the page it knows, and a change of the address cannot put back a tree that is older than that data.
const keepState = (): unknown => window.history.state;
// The topic and the project that the address names; the list of an area is no topic.
export function fromLocation(): { topic: string | null; project: string | null } {
  const query = new URLSearchParams(window.location.search);
  const topic = query.get("settings");
  return {
    topic: topic === "" || topic === "account" ? null : topic,
    project: query.get("project"),
  };
}
export function Settings({
  area,
  viewerId,
  owner,
  projects,
  locale,
  initialTopic,
  initialProject,
}: {
  // The account of the person, or the settings of the workspace and the projects.
  area: SettingsArea;
  viewerId: string;
  owner: boolean;
  projects: Project[];
  locale: string;
  // The topic and the project that the address named, when the settings were opened by an address.
  initialTopic: string | null;
  initialProject: string | null;
}) {
  const t = useTranslations();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [failure, setFailure] = useState<"settingsNoAccess" | "error" | null>(null);
  // Raised when a connection changed, so other sections that list them reload.
  const [connectionsStamp, setConnectionsStamp] = useState(0);
  // The list of the account is `account` in the address and no topic.
  const [topic, setTopic] = useState<string | null>(
    initialTopic === "account" ? null : initialTopic,
  );
  const [chosenProject, setChosenProject] = useState<string | null>(initialProject);
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
  // The account topics need nothing of the people and rights of the workspace.
  useEffect(() => {
    if (area === "workspace") void load();
  }, [area, load]);
  async function act(request: Promise<Response>, after: () => Promise<void>) {
    const response = await request.catch(() => null);
    if (!response?.ok) setFailure("error");
    await after();
  }
  const projectName = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.name ?? projectId;
  const manageable = projects.filter((project) => held(project.id).includes("project.manage"));
  const topicsOf = (projectId: string) =>
    projectTopics.filter(([, , needs]) => needs.some((entry) => held(projectId).includes(entry)));
  const projectChoices = projects.filter((project) => topicsOf(project.id).length > 0);
  const selected =
    projectChoices.find((project) => project.id === chosenProject)?.id ??
    projectChoices[0]?.id ??
    null;
  const noAccess = failure === "settingsNoAccess";
  const topic$ = (id: string, icon: Topic["icon"]): Topic => ({ id, label: t(label(id)), icon });
  const groups: TopicGroup[] =
    area === "account"
      ? [
          {
            id: "account",
            label: t("settingsGroupAccount"),
            topics: [
              topic$("profile", User),
              { id: "notifications", label: t("notifications"), icon: Bell },
              topic$("security", KeyRound),
            ],
          },
        ]
      : [];
  if (area === "workspace" && !noAccess)
    groups.push({
      id: "workspace",
      label: t("settingsGroupWorkspace"),
      topics: [
        topic$("people", Users),
        ...(owner
          ? [
              topic$("workspace", SlidersHorizontal),
              topic$("sso", LogIn),
              topic$("domains", Globe),
              topic$("keys", Lock),
              topic$("workspace-audit", ScrollText),
            ]
          : []),
        // The owner makes the projects, also when there is none yet.
        ...(owner || manageable.length > 0 ? [topic$("projects", Archive)] : []),
        ...(manageable.length > 0 ? [topic$("design", Palette)] : []),
      ],
    });
  if (area === "workspace" && selected)
    groups.push({
      id: "project",
      label: t("settingsGroupProject"),
      lead:
        projectChoices.length > 1 ? (
          <select
            className="settings-project"
            aria-label={t("project")}
            value={selected}
            onChange={(event) => {
              const next = event.target.value;
              go(topicsOf(next).some(([id]) => id === active) ? active : null, next);
            }}
          >
            {projectChoices.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="settings-project-name">{projectName(selected)}</p>
        ),
      topics: topicsOf(selected).map(([id, icon]) => topic$(id, icon)),
    });
  const available = groups.flatMap((group) => group.topics);
  const ready = people !== null || failure !== null;
  // A topic that is not offered (the address of a person with fewer rights, a project that is gone) opens the first one.
  const active = available.find((entry) => entry.id === topic)?.id ?? available[0]?.id ?? "";
  // The topics of the account need no answer; the others are shown when the rights of the person are known.
  const waiting = area === "workspace" && !ready;
  function go(next: string | null, nextProject: string | null = selected) {
    setTopic(next);
    if (nextProject) setChosenProject(nextProject);
    window.history.pushState(keepState(), "", address(next, nextProject, area));
  }
  // The browser's back and forward buttons move between the topics that were opened; the desk puts the part of the
  // settings into the address when they are opened and takes it off when another view is.
  useEffect(() => {
    const follow = () => {
      if (!new URLSearchParams(window.location.search).has("settings")) return;
      const place = fromLocation();
      // An address of the other area is followed by the desk, which shows that area.
      if (areaOf(place.topic) !== area) return;
      setTopic(place.topic);
      if (place.project) setChosenProject(place.project);
    };
    window.addEventListener("popstate", follow);
    return () => {
      window.removeEventListener("popstate", follow);
    };
  }, [area]);
  const render = (): ReactNode => {
    const p = selected;
    const name = p ? projectName(p) : "";
    const a = p ? held(p) : [];
    switch (active) {
      case "profile":
        return <Profile />;
      case "notifications":
        return <NotificationPreferences />;
      case "security":
        return (
          <>
            <SignIn locale={locale} />
            {owner && <OwnerPasskeys locale={locale} />}
          </>
        );
      case "people":
        return (
          <People
            people={people}
            managed={managed}
            owner={owner}
            viewerId={viewerId}
            projects={projects}
            locale={locale}
            projectName={projectName}
            held={held}
            send={send}
            act={act}
            load={load}
          />
        );
      case "workspace":
        return (
          <>
            <WorkspaceControls />
            <Limits />
          </>
        );
      case "sso":
        return <SsoProviders />;
      case "domains":
        return <PortalDomains projectId={null} name="" />;
      case "keys":
        return <KeyRotation />;
      case "workspace-audit":
        return <AuditLog projectId={null} name="" locale={locale} />;
      case "projects":
        return (
          <>
            {owner && <NewProject locale={locale} onCreated={() => void load()} />}
            <ProjectLifecycle manageable={manageable} locale={locale} owner={owner} />
          </>
        );
      case "design":
        return <Designs projects={manageable} locale={locale} />;
    }
    if (!p) return null;
    switch (active) {
      case "general":
        return (
          <Configuration
            key={p}
            projectId={p}
            name={name}
            canWrite={a.includes("config.write")}
            canApprove={a.includes("config.approve")}
            connectionsStamp={connectionsStamp}
          />
        );
      case "connections":
        return (
          <Connections
            key={p}
            projectId={p}
            name={name}
            onChanged={() => {
              setConnectionsStamp((stamp) => stamp + 1);
            }}
          />
        );
      case "intake":
        return (
          <>
            <SenderRules key={`senders-${p}`} projectId={p} name={name} />
            <RoutingRules
              key={`routing-${p}`}
              projectId={p}
              name={name}
              categories={projects.find((project) => project.id === p)?.categories ?? []}
            />
          </>
        );
      case "texts":
        return <Texts key={p} projectId={p} name={name} canWrite={a.includes("config.write")} />;
      case "ai":
        return (
          <AiProfiles
            key={p}
            projectId={p}
            name={name}
            canWrite={a.includes("config.write")}
            canApprove={a.includes("config.approve")}
            connectionsStamp={connectionsStamp}
          />
        );
      case "agents":
        return (
          <>
            {a.includes("ticket.assign") && (
              <ProjectAgentControls key={`controls-${p}`} projectId={p} name={name} />
            )}
            {a.includes("agent.manage") && (
              <Tokens
                key={`tokens-${p}`}
                projectId={p}
                held={a}
                locale={locale}
                send={send}
                act={act}
              />
            )}
          </>
        );
      case "portal":
        return (
          <>
            {a.includes("config.read") && (
              <PortalBranding
                key={`branding-${p}`}
                projectId={p}
                name={name}
                canWrite={a.includes("config.write")}
              />
            )}
            {a.includes("project.manage") && (
              <PortalDomains key={`domains-${p}`} projectId={p} name={name} />
            )}
          </>
        );
      case "replies":
        return (
          <>
            {a.includes("config.read") && (
              <CannedReplies
                key={`replies-${p}`}
                projectId={p}
                name={name}
                canWrite={a.includes("config.write")}
              />
            )}
            {a.includes("project.manage") && (
              <TagAdmin key={`tags-${p}`} projectId={p} name={name} />
            )}
          </>
        );
      case "groups":
        return (
          <GroupsPanel
            key={p}
            projectId={p}
            name={name}
            held={a}
            people={(people ?? []).filter((person) => person.active)}
            onChanged={() => {
              void load();
            }}
          />
        );
      case "webhooks":
        return <Webhooks key={p} projectId={p} name={name} locale={locale} />;
      case "data":
        return (
          <>
            {a.includes("config.read") && (
              <Processing key={`processing-${p}`} projectId={p} name={name} />
            )}
            {a.includes("data.export") && (
              <RequesterExport key={`export-${p}`} projectId={p} name={name} />
            )}
            {a.includes("data.erase") && (
              <EraseRequester key={`erase-${p}`} projectId={p} name={name} />
            )}
          </>
        );
      case "usage":
        return <UsagePanel key={p} projectId={p} name={name} locale={locale} />;
      case "audit":
        return <AuditLog key={p} projectId={p} name={name} locale={locale} />;
    }
    return null;
  };
  const current = available.find((entry) => entry.id === active);
  return (
    <section className="settings" aria-label={t(area === "account" ? "account" : "settings")}>
      <SettingsShell
        backLabel={t(area === "account" ? "account" : "settings")}
        groups={groups}
        active={active}
        level={topic === null ? "list" : "topic"}
        href={(id) => address(id, selected, area)}
        onSelect={(id) => {
          go(id);
        }}
        onBack={() => {
          go(null);
        }}
        heading={
          <>
            <h2>{current?.label}</h2>
            {projectTopicIds.has(active) && selected && (
              <p className="muted">{projectName(selected)}</p>
            )}
            {noAccess && <p className="muted">{t("settingsNoAccess")}</p>}
            {failure === "error" && (
              <p className="error" role="alert">
                {t("error")}
              </p>
            )}
          </>
        }
      >
        {waiting ? <p className="muted">{t("loading")}</p> : render()}
      </SettingsShell>
    </section>
  );
}
