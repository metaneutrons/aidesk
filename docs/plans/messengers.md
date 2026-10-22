# Notifications in messengers: the milestone M10

Initiative of 2026-10-21 at the request of the product owner. It continues the decision of 2026-10-18 on
notifications ([administration plan](administration.md), "Decisions of the product owner"): notifications go out in
the desk and by mail (M9-A1, built); messengers follow in two stages. The milestones M1 to M9 and their criteria stay
as they are. Acceptance authority is this plan. The milestone has an issue, and it is accepted when its criteria have
current evidence against the revision of this plan.

## Baseline on 2026-10-21

What exists:

- **Notifications** (M9-A1): five kinds (new ticket, assignment, mention, overdue, draft), rules per project (nobody,
  the assignee, everybody who may reply), a choice of channels per operator and kind (desk and mail), and a job that
  sends the mail through the outgoing connection of the project. A notification holds the kind, the ticket and the
  time; subject and number are read when it is shown or sent.
- **Webhooks**: a project has endpoints that receive events (ten kinds, among them `ticket.created`,
  `ticket.assigned`, `ticket.overdue` and `draft.created`) as a signed JSON body, with delivery at least once, a log of
  the attempts, a growing pause between retries and the same guard against private addresses as every connection. A
  webhook has a name, an address, a secret, a list of events and a status; its events carry identifiers and a few
  facts.
- **Overview of the processing** (M8-A4): lists for each project the connections, models and webhooks that receive
  content of tickets, with the classes of content (the subject among them).
- **Qualification of the Chat SDK** ([chat-sdk.md](../qualification/chat-sdk.md), 2026-10-18): a spike against a fake
  Slack API showed that the SDK can post to a channel, open a direct message, look up a user by address and run
  several bots with credentials of their own in the worker, with its state in PostgreSQL. It was not run against a
  real workspace and not against Teams.

What is not there: a message in a messenger, in any form.

## Outcome and scope

An operator or a team learns of a ticket in the messenger they work in. Two stages, as decided on 2026-10-18:

1. **Channel messages through webhooks.** A webhook can be given a format that a messenger accepts without a library:
   Slack, Microsoft Teams, Discord, Mattermost, Rocket.Chat and Apprise. The message names the kind of event, the
   number of the ticket and a link; the subject of the ticket only when the project switched that on for this webhook.
2. **Direct messages through the Chat SDK.** A project has a connection to a messenger (Slack first, Teams last); an
   operator who chose the channel "messenger" gets a direct message, found by their address. The SDK is used behind an
   interface of our own, with the version pinned and only the adapters that are installed for a connection that is in
   use.

Non-goals: answering a ticket or pressing a button in a messenger (the second stage of the SDK, with the signature
checks of incoming requests, is a separate decision); tickets that start in a messenger; Discord, Telegram and Google
Chat as direct-message connections; a messenger for customers.

## Design decisions

Taken on 2026-10-18 and kept: a notification holds the subject and a link at most; the subject of a ticket goes to a
messenger only when a channel switches it on, which needs `config.approve`; the overview of M8-A4 lists these channels
as recipients of ticket content. Mail uses the outgoing connection of the project; a messenger has a connection of its
own.

Taken for this plan:

- **A format is a property of a webhook** (`format`, default `aidesk` = today's signed body). A webhook with a chat
  format is a channel: the address is its secret (a messenger's incoming address carries its own key), so the signing
  secret is not used for it. The event kinds that a channel can subscribe to are those that notify operators
  (`ticket.created`, `ticket.assigned`, `ticket.overdue`, `draft.created`) and the status changes; the others stay with
  the format `aidesk`.
- **The text is made by the worker when it delivers**, in the default language of the project, from the event and the
  ticket (number, and the subject only when `withSubject` is on). A ticket that was deleted or became unreadable in the
  meantime is not delivered (the job ends as skipped, as the mail of a notification does).
- **`withSubject` is a field of the webhook that needs `config.approve`** to be switched on, like every change of what
  leaves the system. Without it the message names the kind and the number and carries the link. A change by an agent
  under the review policy waits for a person, as with every webhook.
- **Direct messages follow the choices of the person.** The preferences of an operator get a third channel for each
  kind ("messenger"), off until chosen, because it needs a messenger account that matches their address. A
  notification that the project's rule does not name is not sent in any channel.
- **The interface of our own** has two operations (post to a channel, send to a person by address) and no type of the
  SDK outside one module; credentials are sealed per connection like every secret and are rotated with the keys.

## Milestone M10: Notifications in messengers

Execution: M10 issue.

- M10-A1: A webhook can be given one of the formats Slack, Teams, Discord, Mattermost, Rocket.Chat or Apprise. For
  each of them a delivery sends the body that the messenger documents, with the text in the language of the project, and
  the subject of the ticket only when `withSubject` is on for the webhook (which needs `config.approve`). The settings
  offer the format and the switch; the REST API takes both; the overview of M8-A4 lists the channel with the content
  that it receives. The existing guards (private addresses, development-only addresses, retries, the log of deliveries)
  apply unchanged, and a webhook with the format `aidesk` behaves as before.
- M10-A2: A project can have a connection to Slack (the bot token, sealed), and an operator can choose "messenger" as a
  channel for each kind of notification. The notification reaches them as a direct message, found by their address,
  with the kind, the number, the subject and a link, and with the same checks at send time as the mail (rights, choice
  of the person, ticket exists, project not paused). An operator whose address is not known to the workspace gets
  nothing and the desk says why. The Chat SDK is pinned and used only through the interface of our own; only the Slack
  adapter is installed; its state lives in PostgreSQL through a migration of ours, not through auto-created tables.
  Qualified against a real workspace, with the scopes that were needed written down.
- M10-A3: The same for Microsoft Teams, with the set-up that Teams needs (a bot that is installed in the tenant and an
  endpoint that the service can reach), qualified against a real tenant. Teams is the last piece; it is built only when
  the product owner provides a tenant, and the milestone can be accepted without it only through a decision recorded in
  this plan.

## Order and dependencies

M10-A1 first: it needs nothing new and gives channels at once. M10-A2 next: it adds the SDK, a connection kind and a
channel of the preferences, and needs a real Slack workspace for its qualification (a decision and a resource of the
product owner). M10-A3 last. M10-A2 and A3 use the preferences and the checks of the mail of M9-A1.

## Risks

- A message in a messenger leaves the installation and cannot be taken back; the switch for the subject and the entry
  in the overview of the processing are what keeps this visible. A channel message with the subject is customer text in a
  third party's system.
- The formats of the messengers change; a test against the documented body is not a test against the service. Each format
  is checked against its documentation and, as far as an account is available, against the service; what was not run
  against the service is said in the pull request.
- The SDK is young (4.x) and brings many packages. The version is pinned, `pnpm audit` and the licences are checked on
  every change of the lockfile, and the adapter of a messenger is installed only with its connection kind.
- Teams needs infrastructure that a small team may not want to run; hence last, and optional by decision.

## Decisions needed from the product owner

- Which messengers are used in practice. This decides the order of the formats and whether A2 and A3 are built.
- A Slack workspace (or an account of another messenger) for the qualification of M10-A2, and a Teams tenant for M10-A3.
- Whether the subject of a ticket may go to a channel at all (the switch exists, the default is off).
