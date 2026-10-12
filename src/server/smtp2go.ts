// SMTP2GO accepts mail for a suppressed recipient during the SMTP dialog and
// drops it afterwards, so the send would look delivered. A connection can
// therefore check the recipient against the account's suppression list
// through the API before sending.
const endpoint = "https://api.smtp2go.com/v3/suppression/view";
export async function smtp2goSuppressed(apiKey: string, address: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "X-Smtp2go-Api-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email_address: address }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("suppression_check_failed");
  }
  const body: unknown = await response.json().catch(() => null);
  const results =
    typeof body === "object" && body !== null && "data" in body
      ? (body as { data?: { results?: unknown } }).data?.results
      : undefined;
  if (!response.ok || !Array.isArray(results)) throw new Error("suppression_check_failed");
  // The API also returns domain-wide suppressions for the address.
  return results.length > 0;
}
