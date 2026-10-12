# Channel contracts

Review for M2-A10, state of the code at the time of writing. Email is the only
implemented channel. WhatsApp, Telegram and Signal are reserved in
`src/domain/channels.ts` with `implemented: false`; no messenger credentials,
adapters or live tests exist, and nothing in the interface offers one (a test
checks the interface texts and the registry).

## What an adapter is today

An inbound adapter (IMAP, Cloudflare) hands raw RFC 822 bytes and an external
key to `acceptInbound`. The key is namespaced by the adapter (for example
`imap:<connection>:<uidvalidity>:<uid>`) and unique within the project that the
mail is delivered to. The original is stored first, then the ingress record and
its job are committed together; processing is idempotent. An outbound
connection is chosen per project (`outboundConnectionId`) and the worker
dispatches by connection kind. The two directions are independent: inbound and
outbound connections are separate records, and the registry admits a transport
only in the direction it was built for.

## Boundaries that are tested

- The same external key in two projects (or from two accounts) is two ingress
  records. Before this review the key was unique across all projects, so a
  colliding key could drop a message of another project; it is now unique per
  project. The same key within a project stays one message, and the same
  message arriving through two accounts of a project becomes one ticket.
- Duplicate input is recognised by key and by Message-ID, per project.
- A connection must be an outbound connection of the project that sends; an
  inbound connection or one of another project makes the dispatch stale and
  sends nothing.
- The project's outgoing connection cannot be changed through the settings
  operation, only acknowledgements can.
- The registry matches what the worker really sends and polls, so a transport
  cannot be offered that the worker does not handle.

## Where email is still built in

These are the places a second channel would have to change. They are listed so
the change is made deliberately; no abstraction is built for one channel.

| Area                   | Email assumption                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| Identity               | `tickets.requesterEmail`, `participants.email` and `messages.authorEmail` are mail addresses                  |
| Inbound core           | `processIngress` parses RFC 822, threads by Message-ID and References, detects automatic mail by mail headers |
| Junk and bounces       | Spam verdicts come from mail headers, delivery reports are RFC 3464                                           |
| Outbound               | The worker builds a mail (subject `Re: …`, HTML wrapper, In-Reply-To) and classifies SMTP failures            |
| Conversation reference | A ticket has no channel or conversation reference besides the requester address                               |
| Capabilities           | Declared for email in the registry, but not consulted when rendering; there is one channel                    |

## What a messenger needs first

1. A conversation record with a channel and an account identity, and a
   participant identity of the form (channel, account, external id) next to the
   address. Identities are never merged by display name; linking across
   channels is an explicit, verified, project-scoped action.
2. An inbound handler that turns a platform event into the shared message
   model (Markdown, attachments, a namespaced external key) and goes through the
   same admission, junk, threading and audit steps. Mail-specific parts (MIME
   preview, extraction of quoted history) stay in the mail adapter.
3. An outbound handler with declared capabilities (length, formatting, media,
   receipts) that returns the same three outcomes as mail: accepted, rejected
   before the platform took responsibility, or unknown, which is never retried
   automatically. Replies default to the channel of the conversation; sending
   elsewhere needs a verified destination and an explicit action.
4. Persistent private state outside Vercel functions for connectors that need
   it (Signal), and platform-specific constraints such as the WhatsApp session
   window.

## Open

Real adapters need their own inbound, reply, media, status and deployment
evidence, and the actual messenger subset is not decided. This review does not
qualify any of them.
