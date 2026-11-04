"use client";
import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Tag, X } from "lucide-react";
import { textOn } from "../domain/branding";
import { maxTags, normalizeTag, tagPattern, tagStyle } from "../domain/tags";
// The team's own labels on a ticket. Every change saves the whole list; it
// does not touch the conversation. Suggestions are the tags already in use in
// the ticket's project.
export function Tags({
  ticketId,
  projectId,
  tags,
  colors = {},
  onChanged,
}: {
  ticketId: string;
  projectId: string;
  tags: string[];
  colors?: Record<string, string>;
  onChanged: () => void;
}) {
  const t = useTranslations();
  const listId = useId();
  const [value, setValue] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    void fetch(`/api/v1/tags?project=${projectId}`)
      .then((response) => (response.ok ? response.json() : []))
      .then((rows: unknown) => {
        if (current && Array.isArray(rows))
          setSuggestions(
            rows.flatMap((row: unknown) =>
              typeof row === "object" && row !== null && "tag" in row && typeof row.tag === "string"
                ? [row.tag]
                : [],
            ),
          );
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [projectId, tags]);
  async function save(next: string[]) {
    setFailed(false);
    const response = await fetch(`/api/v1/tickets/${ticketId}/tags`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: next }),
    }).catch(() => null);
    if (!response?.ok) {
      setFailed(true);
      return;
    }
    setValue("");
    onChanged();
  }
  const candidate = normalizeTag(value);
  const valid = tagPattern.test(candidate) && !tags.includes(candidate) && tags.length < maxTags;
  return (
    <div className="tags">
      <Tag size={16} aria-hidden="true" />
      <ul className="tag-list" aria-label={t("tags")}>
        {tags.map((tag) => (
          <li key={tag} className="tag-chip" style={tagStyle(colors[tag], textOn)}>
            <span>{tag}</span>
            <button
              type="button"
              aria-label={t("tagRemove", { tag })}
              onClick={() => {
                void save(tags.filter((entry) => entry !== tag));
              }}
            >
              <X size={12} />
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) void save([...tags, candidate]);
        }}
      >
        <label>
          <span className="visually-hidden">{t("tagAdd")}</span>
          <input
            list={listId}
            value={value}
            maxLength={60}
            placeholder={t("tagAdd")}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </label>
        <datalist id={listId}>
          {suggestions
            .filter((tag) => !tags.includes(tag))
            .map((tag) => (
              <option key={tag} value={tag} />
            ))}
        </datalist>
        <button type="submit" className="secondary" disabled={!valid}>
          {t("tagAddButton")}
        </button>
      </form>
      {tags.length >= maxTags && (
        <small className="muted">{t("tagLimit", { count: maxTags })}</small>
      )}
      {value !== "" && !valid && tags.length < maxTags && !tags.includes(candidate) && (
        <small className="muted">{t("tagInvalid")}</small>
      )}
      {failed && (
        <small className="error" role="alert">
          {t("error")}
        </small>
      )}
    </div>
  );
}
