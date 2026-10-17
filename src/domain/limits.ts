import { z } from "zod";
// The limits that an owner sets for the whole installation. The defaults are the values that were
// constants of the code, so an installation that changes nothing behaves as before. The bounds keep
// each value inside what the rest of the system can carry: a file of a received mail has to fit into the
// raw mail that is accepted (25 MB, and base64 makes a file a third larger), the body of a reply of a
// customer has to fit into what the proxy in front lets through (40 MB), and a session cannot last
// longer than the cookie that carries it.
export const MiB = 1024 * 1024;
export const limitDefaults = {
  intakeFiles: 25,
  intakeFileMiB: 15,
  portalFiles: 10,
  portalTotalMiB: 30,
  sessionHours: 12,
  portalLinkDays: 30,
} as const;
export type LimitKey = keyof typeof limitDefaults;
export type Limits = Record<LimitKey, number>;
// The lowest and the highest value of each limit.
export const limitBounds = {
  intakeFiles: [1, 50],
  intakeFileMiB: [1, 18],
  portalFiles: [1, 25],
  portalTotalMiB: [1, 30],
  sessionHours: [1, 720],
  portalLinkDays: [1, 90],
} as const satisfies Record<LimitKey, readonly [number, number]>;
export const limitKeys = Object.keys(limitDefaults) as LimitKey[];
const bounded = (key: LimitKey) =>
  z.number().int().min(limitBounds[key][0]).max(limitBounds[key][1]);
export const limitsInput = z
  .object({
    intakeFiles: bounded("intakeFiles")
      .optional()
      .describe("Most files that one received mail may carry; more are kept as a refusal"),
    intakeFileMiB: bounded("intakeFileMiB")
      .optional()
      .describe("Largest file of a received mail or of a reply of a customer, in MiB"),
    portalFiles: bounded("portalFiles")
      .optional()
      .describe("Most files that a customer may send with one reply"),
    portalTotalMiB: bounded("portalTotalMiB")
      .optional()
      .describe("Most that the files of one reply of a customer may weigh together, in MiB"),
    sessionHours: bounded("sessionHours")
      .optional()
      .describe(
        "How long a sign-in of an operator lasts; applies to sessions that start afterwards",
      ),
    portalLinkDays: bounded("portalLinkDays")
      .optional()
      .describe("How long a link to the customer page is valid when no length is asked for"),
  })
  .strict()
  .refine((values) => Object.values(values).some((value) => value !== undefined), {
    message: "Name at least one limit",
  });
export type LimitsInput = z.infer<typeof limitsInput>;
// The values that the code checks, in bytes.
export const fileRules = (limits: Limits) => ({
  maxCount: limits.intakeFiles,
  maxBytes: limits.intakeFileMiB * MiB,
});
export const portalRules = (limits: Limits) => ({
  count: limits.portalFiles,
  bytes: limits.portalTotalMiB * MiB,
});
