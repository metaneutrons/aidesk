import { isMessageId } from "./threading";
// A delivery status notification (RFC 3464): multipart/report with
// report-type=delivery-status. The parser merges the machine-readable part into
// the text, so the fields are read from there; the returned original headers
// come as separate parts.
export interface DeliveryReport {
  action: string;
  status: string | null;
  recipient: string | null;
  diagnostic: string | null;
  originalMessageId: string | null;
}
function field(block: string, name: string): string | null {
  const match = new RegExp(`^${name}:[ \\t]*(.+)$`, "im").exec(block);
  return match?.[1]?.trim() ?? null;
}
export function parseDeliveryReport(
  contentType: unknown,
  text: string,
  originals: readonly string[],
): DeliveryReport | null {
  const type = contentType as { value?: unknown; params?: Record<string, unknown> } | undefined;
  const reportType = type?.params?.["report-type"];
  if (
    type?.value !== "multipart/report" ||
    typeof reportType !== "string" ||
    reportType.toLowerCase() !== "delivery-status"
  )
    return null;
  // One block per recipient; a failure outranks everything else.
  const blocks = text
    .split(/\r?\n\r?\n/)
    .filter((block) => /^Action:/im.test(block))
    .map((block) => ({
      action: (field(block, "Action") ?? "").toLowerCase(),
      status: /^\d\.\d{1,3}\.\d{1,3}$/.exec(field(block, "Status") ?? "")?.[0] ?? null,
      recipient:
        /^rfc822;[ \t]*(\S+)$/i.exec(field(block, "Final-Recipient") ?? "")?.[1]?.toLowerCase() ??
        null,
      diagnostic: field(block, "Diagnostic-Code")?.slice(0, 300) ?? null,
    }));
  const chosen = blocks.find((block) => block.action === "failed") ?? blocks[0];
  if (!chosen) return null;
  const original = originals
    .map((part) => /^Message-ID:[ \t]*(<[^<>\s]+>)[ \t]*$/im.exec(part)?.[1])
    .find((id): id is string => isMessageId(id));
  return { ...chosen, originalMessageId: original ?? null };
}
