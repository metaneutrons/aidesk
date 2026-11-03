"use client";
import type { ComponentType, ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight } from "lucide-react";
// The frame of the settings: a list of topics on the left, one topic on the right, and on a narrow screen the list and
// the topic one after the other, as the settings of a phone do. A topic has an address of its own (a real link), so
// that it can be opened in a new tab and the browser's back button leads to the topic before.
export interface Topic {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
}
export interface TopicGroup {
  id: string;
  label: string;
  topics: Topic[];
  // What stands between the heading of the group and its topics, such as the choice of the project.
  lead?: ReactNode;
}
export function SettingsShell({
  groups,
  active,
  level,
  href,
  onSelect,
  onBack,
  heading,
  children,
}: {
  groups: TopicGroup[];
  active: string;
  // On a narrow screen only one of the two parts is shown.
  level: "list" | "topic";
  href: (topic: string) => string;
  onSelect: (topic: string) => void;
  onBack: () => void;
  heading: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations();
  return (
    <div className="settings-layout" data-level={level}>
      <aside className="settings-list" aria-label={t("settingsTopics")}>
        {groups.map((group) => (
          <section key={group.id} aria-labelledby={`settings-group-${group.id}`}>
            <h2 id={`settings-group-${group.id}`} className="settings-group-title">
              {group.label}
            </h2>
            {group.lead}
            <ul>
              {group.topics.map((topic) => (
                <li key={topic.id}>
                  <a
                    className="settings-topic"
                    href={href(topic.id)}
                    aria-current={topic.id === active ? "page" : undefined}
                    onClick={(event) => {
                      // A click with a modifier key opens the link as the browser does it.
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
                        return;
                      event.preventDefault();
                      onSelect(topic.id);
                    }}
                  >
                    <span className="settings-topic-icon">
                      <topic.icon size={16} aria-hidden />
                    </span>
                    <span>{topic.label}</span>
                    <ChevronRight className="settings-topic-chevron" size={16} aria-hidden />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </aside>
      <div className="settings-detail">
        <button type="button" className="settings-back" onClick={onBack}>
          <ChevronLeft size={18} aria-hidden />
          {t("settings")}
        </button>
        <div className="settings-detail-body">
          <header className="settings-detail-head">{heading}</header>
          {children}
        </div>
      </div>
    </div>
  );
}
