import { z } from "zod";
import { priorities } from "./triage";
// A saved view of the inbox (M9-A3): a name and the filters of the desk, which a person saves, applies with one choice
// and can make the one that the desk opens with. A view is a filter of what the person may read anyway: it names
// projects, and a project that the person may not read (any more) is not shown, so a view never shows more than the
// grants allow. Every operator has their own views; nobody sees those of another.
export const viewLists = ["inbox", "overdue", "reminders", "waiting", "resolved"] as const;
export type ViewList = (typeof viewLists)[number];
export const maxViews = 20;
export const maxViewProjects = 50;
const name = z.string().trim().min(1).max(60);
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === "" ? null : value))
    .nullable();
// The filters. A missing filter means none: "projects: []" is all the projects that the person may read.
const filters = {
  list: z.enum(viewLists),
  projects: z
    .array(z.uuid())
    .max(maxViewProjects)
    .transform((values) => [...new Set(values)]),
  tag: text(100),
  priority: z.enum(priorities).nullable(),
  category: text(100),
};
export const viewCreate = z.object({ name, ...filters }).strict();
export const viewUpdate = z
  .object({
    name: name.optional(),
    list: filters.list.optional(),
    projects: filters.projects.optional(),
    tag: filters.tag.optional(),
    priority: filters.priority.optional(),
    category: filters.category.optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "Name at least one field",
  });
export const viewStart = z.object({ start: z.boolean() }).strict();
export const viewOut = z.object({
  id: z.uuid(),
  name: z.string(),
  list: z.enum(viewLists),
  // The projects of the view that the person may read now.
  projects: z.array(z.uuid()),
  // The view named projects and the person may read none of them any more: it shows nothing and is not applied.
  restricted: z.boolean(),
  tag: z.string().nullable(),
  priority: z.enum(priorities).nullable(),
  category: z.string().nullable(),
  start: z.boolean(),
});
export const viewListOut = z.object({ views: z.array(viewOut) });
export type SavedView = z.infer<typeof viewOut>;
