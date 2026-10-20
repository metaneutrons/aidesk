import { z } from "zod";
// The erasure of a ticket, or of everything about one requester (see `server/erasure.ts`). A person with `data.erase`
// first asks what would be removed, and sends the numbers back to confirm: a different number now (a mail arrived
// meanwhile) is a conflict and nothing is removed. What has left the system cannot be taken back, and the result
// names it.
export const erasureCounts = z.object({
  tickets: z.number().int().min(0),
  messages: z.number().int().min(0),
  // Files that were received with messages, and the original mails (of messages and of mail kept out).
  attachments: z.number().int().min(0),
  originals: z.number().int().min(0),
  translations: z.number().int().min(0),
  // Links to issues and drafts of issues.
  issueLinks: z.number().int().min(0),
  // Portal records: the addresses that may open the customer page of a ticket.
  portalRecords: z.number().int().min(0),
  // Records of the runs of agents.
  runs: z.number().int().min(0),
  // Jobs that are queued or kept for these tickets.
  jobs: z.number().int().min(0),
  // Mails of the requester that no ticket holds (junk, delivery reports) and mail that was read for the tickets.
  ingress: z.number().int().min(0),
});
export type ErasureCounts = z.infer<typeof erasureCounts>;
// What the system cannot reach: copies that were handed on before.
export const outOfReach = z.object({
  // Webhook events about these tickets that were delivered; the receiver keeps what it got.
  webhookEvents: z.number().int().min(0),
  // Issues that were created in a repository from these tickets.
  issuesCreated: z.number().int().min(0),
  // Exports of the project that were made earlier and hold the data.
  exports: z.number().int().min(0),
});
export const erasurePreview = z.object({
  counts: erasureCounts,
  outOfReach,
  // A description of the scope for the confirmation: the number of a ticket, or the number of tickets of the requester.
  tickets: z.array(z.object({ id: z.uuid(), number: z.number().nullable(), subject: z.string() })),
});
// An address as the requester is looked up: trimmed, lower case, and an address.
const address = z.string().trim().toLowerCase().pipe(z.email().max(320));
export const erasureConfirm = z.object({ expected: erasureCounts }).strict();
export const requesterConfirm = z
  .object({
    email: address,
    expected: erasureCounts,
  })
  .strict();
export const requesterQuery = z.object({
  email: address,
});
export const erasureResult = z.object({
  counts: erasureCounts,
  objects: z.object({
    removed: z.number().int().min(0),
    // Files that another message or ticket still uses.
    shared: z.number().int().min(0),
    // Files that could not be removed now; the sweep of the storage takes them later.
    failed: z.number().int().min(0),
  }),
  outOfReach,
});
