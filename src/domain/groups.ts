import { z } from "zod";
import { actions } from "./permissions";
// A group of operators in one project. Every member holds the actions of the group in that project, besides what
// their own membership gives. Nobody gives more than they hold: the actions of a group are limited to those of the
// person who sets them, and so is whom they add.
export const groupName = z.string().trim().min(1).max(60);
export const groupActions = z
  .array(z.enum(actions))
  .max(actions.length)
  .transform((values) => [...new Set(values)]);
export const groupCreate = z
  .object({
    name: groupName,
    actions: groupActions,
  })
  .strict();
export const groupUpdate = z
  .object({
    name: groupName.optional(),
    actions: groupActions.optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.actions !== undefined, {
    message: "Name at least one field",
  });
export const groupMemberInput = z
  .object({
    userId: z.string().min(1).max(100),
    member: z.boolean().describe("true adds the operator to the group, false removes them"),
  })
  .strict();
export const groupOut = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  actions: z.array(z.string()),
  members: z.array(
    z.object({ id: z.string(), name: z.string(), email: z.string(), active: z.boolean() }),
  ),
});
