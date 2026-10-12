// The channels the product can carry conversations on, and what is built for
// each. A channel is reserved until an adapter exists and has been qualified;
// a reserved channel is never offered or presented as working. Transports are
// the connection kinds an adapter uses (the `kind` of a connection).
export interface ImplementedChannel {
  implemented: true;
  inbound: readonly string[];
  outbound: readonly string[];
  capabilities: {
    html: boolean;
    plainText: boolean;
    attachments: boolean;
    threading: "message-id";
    // The channel needs a mail address as the identity of a participant.
    identity: "email";
  };
}
export interface ReservedChannel {
  implemented: false;
}
export const channels = {
  email: {
    implemented: true,
    inbound: ["imap", "cloudflare"],
    outbound: ["smtp", "cloudflare"],
    capabilities: {
      html: true,
      plainText: true,
      attachments: true,
      threading: "message-id",
      identity: "email",
    },
  },
  whatsapp: { implemented: false },
  telegram: { implemented: false },
  signal: { implemented: false },
} as const satisfies Record<string, ImplementedChannel | ReservedChannel>;
export type ChannelId = keyof typeof channels;
export function implementedChannels(): ChannelId[] {
  return (Object.keys(channels) as ChannelId[]).filter((id) => channels[id].implemented);
}
// The channel that a connection kind belongs to in the given direction, or
// null for an unknown kind or one used in the wrong direction.
export function channelOf(kind: string, direction: "inbound" | "outbound"): ChannelId | null {
  for (const id of implementedChannels()) {
    const channel = channels[id];
    if (channel.implemented && (channel[direction] as readonly string[]).includes(kind)) return id;
  }
  return null;
}
