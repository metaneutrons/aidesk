# Customers in messengers: the milestone M12

Initiative of 2026-10-22 at the request of the product owner. It is the external side of the messengers: a customer
writes to a project in a messenger that the customer uses already, and gets the answers there. The internal side (the
team is told in a messenger) is [M10](messengers.md) and is independent of this plan. The milestones M1 to M11 and their
criteria stay as they are. Acceptance authority is this plan. The milestone has an issue, and it is accepted when its
criteria have current evidence against the revision of this plan.

## Baseline on 2026-10-22

- **Channels in.** A ticket starts with a mail (an IMAP mailbox or Cloudflare Email Routing) and goes on with a mail or a
  reply on the customer page that a link opens. The sender is identified by the address of the mail, in lower case.
- **Identity.** The customer of a ticket is `requesterEmail` and `requesterName` of the ticket; the right to open the
  customer page is a record of that address on that ticket. Nothing else identifies a customer.
- **What hangs on the address.** Junk rules and the lists of senders (M7), the threading of replies, the portal links, the
  erasure and the export about a requester, and the periods of retention (M8) all find a customer by the address.
- **Out.** A reply leaves through the outgoing mail connection of the project, with the signature of the operator and,
  if the project wants it, a link to the customer page.
- **Around.** Attachments with limits and the reading of their text, the translation of a message, the approval policy for
  what an agent sends, and the overview of the processing exist for mail.

What is not there: any messenger as a channel for customers, and any customer identity that is not an address.

## Outcome and scope

A customer sends a message to a project in a messenger and the operator sees it as a ticket like every other: the same
list, the same thread, the same reply field. The reply goes out in the same messenger, in the language of the customer. A
person who does not want this channel is not written to in it.

The undertaking starts with **one messenger**, chosen by the product owner after a qualification, and with the functions
that mail has today (a ticket, replies, files, translation, the customer page, erasure and export). Another messenger is
another connection kind later, on the same model.

Non-goals: voice calls and video; group chats and channels as customers; more than one messenger in the first delivery;
messages that the system starts without a ticket (news, advertising); a bot that talks to customers on its own (an
agent answers as it does for mail, under the approval policy of the project); a customer who is told of a ticket in a
messenger that was not the channel of the ticket.

## Questions that the design has to answer

These are open and are answered in M12-A1, in this plan, before code is written.

- **Which messenger.** The candidates differ in what a business may do: a business interface that is official, what it costs,
  whether a business may write first or only answer within a time window or with approved templates, whether a customer has
  to start the conversation, what a message and a file may be, what the provider says about delivery and read, and where
  the data is held. Candidates to look at are WhatsApp (business platform), Telegram (bot), Signal (no business interface
  that is known), Matrix and the messengers of workplaces (Slack, Teams, with external guests). What the plan says about
  them is to be verified against the documentation and an account of the provider.
- **Who the customer is.** A messenger gives an account id or a phone number, not an address. The model has to say whether a
  customer has several identities (an address and a messenger id), whether a ticket keeps one primary identity, how an
  identity is shown to the operator, what happens when a number changes hands, and how a customer who wrote in mail is
  recognised in the messenger (only through a step that the customer takes, such as a code that the customer sends back).
- **The basis and the notice.** What the legal basis is for writing to a customer in a messenger, what the first answer
  tells the customer (who is writing, what is kept, how to stop), how a customer stops it, and what happens to the history.
- **What the provider receives.** The provider of the messenger receives every message in both directions. The overview of
  the processing lists it; a project that must not use it leaves the connection out.
- **Abuse.** Rates per sender, sizes of messages and files, blocked senders, and what junk means in a messenger.

## Milestone M12: Customer messenger

Execution: M12 issue.

- M12-A1: A qualification and a design of the first messenger, written into this plan: the candidates are compared against
  their documentation and an account, the choice and its reasons are recorded, and the answers to the questions above are
  recorded as decisions. The qualification runs against a real account (sender identity, the signature of an incoming
  request, an outgoing message within the rules of the provider, a file, the status of delivery, the cost) and states what it
  did not cover. No product code, except what the spike needs, which is not merged.
- M12-A2: A connection to the messenger (an endpoint that receives messages and checks their signature, an outgoing call, the
  credentials sealed like every secret). A message creates a ticket or continues one for the identity of the sender; the
  ticket shows its channel; an operator's reply, and a reply of an agent under the approval policy, goes out through the same
  connection with the checks that a mail reply has (rights, project not paused, ticket exists, rules of the provider). A
  message that the provider delivers twice creates one entry. Limits and blocked senders apply as they do for mail.
- M12-A3: Data protection works for the channel from the first day: the notice and the way to stop it, the erasure and the
  export about a requester (M8) cover the identity of the channel and the raw messages that were received, the periods of
  retention apply, the overview of the processing lists the provider, and every step that changes who is written to is in the
  audit.
- M12-A4: The functions around the thread work for the channel as they do for mail: files within the limits and the reading
  of their text, the translation of a message and of a reply, and the link to the customer page, shown as a message.

## Order and dependencies

M12-A1 first, and nothing else begins before the product owner has taken the decisions that A1 leaves. M12-A2 and A3
belong together: no channel goes live without the data protection of A3. M12-A4 is last. The undertaking depends on the
erasure core, the retention and the export of M8, the sender rules of M7 and the limits of M6, all of which are built.
M12 is accepted by its own criteria after the acceptance of M1 to M10 in [M11](acceptance.md), or in parallel when the product
owner decides so; it is not part of M11.

## Risks

- A provider can change its rules or its price, close an account or refuse templates; the evidence of A1 is dated and says
  which version of the rules it saw.
- A customer identity that is not an address touches everything that hangs on the address (see the baseline); a design that
  forgets one place leaves data that erasure and export do not find.
- A message in a messenger cannot be taken back, and a customer who answers in the wrong chat is a data incident; the
  identity of the customer has to be checked by a step of the customer before the first reply with personal content.
- The provider is a recipient of customer data in a third country in some cases; this is a decision of the product owner with
  legal advice, and it is not made here.
- The public endpoint that receives messages is a new surface; it checks every signature, answers quickly and does its work
  in a job, like the inbound mail.

## Decisions of the product owner

Taken on 2026-10-24:

- **The first messenger is not fixed yet; the focus is WhatsApp** (the business platform of Meta). The choice and the
  account for the qualification follow M12-A1. What this plan says about the cost, the templates and the time window of
  WhatsApp is to be verified against the documentation of the provider and an account.
- **The project only answers.** A customer writes first; the project does not write to a customer who did not, so there
  is no first contact, no template for one and no consent to collect for one.
- **The legal basis and the text of the notice** are proposed in M12-A1 and decided by the product owner with legal
  advice; nothing is written to a customer before that.
- **An agent may answer in the channel only when the project is configured so.** It is off by default, and an agent
  answers under the approval policy of the project, as it does for mail.
- **M12 starts in parallel to M11.** It is not part of the acceptance in M11, which stays on its named revision.
