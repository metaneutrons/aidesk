import { z } from "zod";
import { hostName } from "./portal-domains";
// The identity providers that an owner registers: what is asked for, in a shape that the settings and the API
// share. The plugin takes more than this (several domains, organizations, private key authentication); only what
// the product uses is offered.
export const providerId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,43}$/, "Lower case letters, digits and hyphens, at most 44")
  .describe(
    "A name for the provider in lower case; it is part of the address that the provider calls back",
  );
const oidc = z
  .object({
    clientId: z.string().trim().min(1).max(200),
    clientSecret: z.string().min(1).max(500),
    discoveryEndpoint: z
      .url()
      .max(500)
      .optional()
      .describe("Defaults to the well-known address of the issuer"),
    scopes: z.array(z.string().min(1).max(100)).max(20).optional(),
    pkce: z.boolean().optional(),
  })
  .strict();
const saml = z
  .object({
    entryPoint: z.url().max(500),
    cert: z
      .string()
      .trim()
      .min(50)
      .max(20_000)
      .describe("The signing certificate of the provider (PEM)"),
    audience: z.string().trim().min(1).max(300).optional(),
  })
  .strict();
export const ssoRegisterInput = z
  .object({
    providerId,
    issuer: z.url().max(500),
    domain: hostName.describe(
      "The domain of the e-mail addresses of the operators who sign in through it",
    ),
    oidc: oidc.optional(),
    saml: saml.optional(),
  })
  .strict()
  .refine((value) => (value.oidc === undefined) !== (value.saml === undefined), {
    message: "Give either oidc or saml",
  });
export type SsoRegisterInput = z.infer<typeof ssoRegisterInput>;
// What can be changed afterwards: the domain (which asks for a new proof), the secret of an OIDC client, the scopes.
export const ssoUpdateInput = z
  .object({
    domain: hostName.optional(),
    clientSecret: z.string().min(1).max(500).optional(),
    scopes: z.array(z.string().min(1).max(100)).max(20).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "Name at least one field",
  });
export const ssoDeleteInput = z.object({ confirm: z.string().min(1).max(100) }).strict();
// The record that proves a domain, as the plugin reads it.
export const domainRecord = (id: string, domain: string, token: string) => ({
  name: `_better-auth-token-${id}.${domain}`,
  value: `_better-auth-token-${id}=${token}`,
});
