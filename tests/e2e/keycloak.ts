import { readFileSync } from "node:fs";
// Host-side access to the development IdP's admin API, so the admin password
// never enters the application container.
const base = process.env.E2E_KEYCLOAK_URL ?? "http://localhost:8080";
function localSecret(name: string): string {
  const line = readFileSync(".env.development", "utf8")
    .split("\n")
    .find((entry) => entry.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} is missing from .env.development.`);
  return line.slice(name.length + 1);
}
async function adminHeaders(): Promise<Headers> {
  const response = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: "admin",
      password: localSecret("KEYCLOAK_ADMIN_PASSWORD"),
    }),
  });
  if (!response.ok) throw new Error(`Keycloak admin token failed: ${String(response.status)}`);
  const { access_token: token } = (await response.json()) as { access_token: string };
  return new Headers({ authorization: `Bearer ${token}`, "content-type": "application/json" });
}
export async function createIdpUser(email: string, password: string): Promise<void> {
  const response = await fetch(`${base}/admin/realms/aidesk/users`, {
    method: "POST",
    headers: await adminHeaders(),
    body: JSON.stringify({
      username: email,
      email,
      emailVerified: true,
      enabled: true,
      firstName: "E2E",
      lastName: "SSO",
      credentials: [{ type: "password", value: password, temporary: false }],
    }),
  });
  if (response.status !== 201)
    throw new Error(`Keycloak user creation failed: ${String(response.status)}`);
}
export async function deleteIdpUser(email: string): Promise<void> {
  const headers = await adminHeaders();
  const found = await fetch(
    `${base}/admin/realms/aidesk/users?exact=true&email=${encodeURIComponent(email)}`,
    { headers },
  );
  const users = (await found.json()) as { id: string }[];
  for (const entry of users)
    await fetch(`${base}/admin/realms/aidesk/users/${entry.id}`, { method: "DELETE", headers });
}
