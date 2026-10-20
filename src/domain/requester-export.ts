import { z } from "zod";
// What the system holds about one requester (see `server/requester-export.ts`), for a request for information. The
// body names the address; the answer is the file itself, which is not kept anywhere.
export const requesterExportInput = z
  .object({ email: z.string().trim().toLowerCase().pipe(z.email().max(320)) })
  .strict();
export const requesterExportFormat = "aidesk-requester-export-1";
