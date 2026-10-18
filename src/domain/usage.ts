import { z } from "zod";
// The usage of a project that the settings and the API show: the calls of the AI task by task and day, the mail by
// day, and what is stored. The window is a number of days that ends today (UTC).
export const usageQuery = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(90)
    .default(14)
    .describe("How many days, ending today (UTC)"),
});
