# Acceptance of the milestones M1 to M10: the milestone M11

Initiative of 2026-10-22 at the request of the product owner: all acceptances move to a milestone M11. This plan
adds no function. It says when and how the milestones that are built are accepted, so that the epic can be closed.
The acceptance authority of each milestone stays its own plan ([initial product](initial-product.md),
[completion of M3 and M4](m4-completion.md), [administration](administration.md), [messengers](messengers.md));
this plan is the authority for M11 only.

## Baseline on 2026-10-22

- M6 to M9 are built and merged to `main`; each milestone issue holds a sheet that maps every criterion to the pull
  requests, the tests and a green run of the CI at one revision (`cc04ef7`, run 39715565552). None is accepted.
- M10 is planned, nothing is built.
- M1 to M5 are implemented as far as the development stack allows. Their issues name what is open and cannot be
  closed there: a production identity provider and a remote HTTPS client on a production deployment (M1, M4), a real
  IMAP mailbox and the rendered mail in real mail programs (M2), custom portal domains on a deployment and the check
  with a screen reader (M3), real runs against GitHub, a documentation site, a customer system and a second model
  provider (M4), and a production deployment with TLS in front of it, a measured recovery and a run of the suite
  against a deployment (M5).
- No milestone and not the epic is closed.

## Decision

The acceptance of every milestone is not recorded in its issue now. It is done once, together, in M11: on one named
revision, with evidence that is current for it, and by the product owner. Until then each milestone issue stays open,
says "built, acceptance in M11" (M10: "planned" or "built", as it is), and keeps "Not accepted" in its acceptance
record. The sheets that exist stay valid as the starting point; the acceptance uses them where they are still current.

## Scope and non-goals

In scope: the evidence, the open items of M1 to M5, the walk-through of the product owner, and the recorded decisions
about what is accepted, waived or cancelled. Out of scope: new functions (what a walk-through finds is a new item in
the plan of the milestone it belongs to, or a decision to accept it as a limit), publication of a release, the
messengers beyond what M10 delivers, and the customer channel in messengers (M12, accepted by its own plan after this one).

## Milestone M11: Acceptance

Execution: M11 issue.

- M11-A1: One revision of `main` is named for the acceptance. For each milestone M1 to M10 a sheet at that revision
  maps every criterion to current evidence (tests, a green run of the CI of that revision, a qualification with its
  date) and to the limits that the pull requests state. A sheet of an earlier revision is renewed for the criteria that a
  later change touched; a criterion that no evidence reaches is named as open and not counted.
- M11-A2: Every open item that the issues of M1 to M5 name is closed with evidence or is waived by a decision that is
  recorded in the plan of its milestone (with the reason and the consequence), or its milestone is cancelled in the same
  way. Nothing is closed by saying that it is probably fine.
- M11-A3: A deployment that is not a development stack runs the revision under acceptance (migrations applied, the
  workers running as in production), and the remote suite ([p7-staging.md](../qualification/p7-staging.md)) passed
  against it. Where a milestone needs a real service (a mailbox, a model provider, an identity provider, a messenger),
  the evidence of that service is part of A1 or is waived under A2.
- M11-A4: The product owner records the acceptance, a waiver or a cancellation in each milestone issue (the acceptance
  record names the revision and the sheet) and the epic is closed after the last one. A milestone issue is closed as
  completed only when every applicable criterion and dependency is satisfied.

## Order and dependencies

M11-A1 needs M10 built, or M10 left out of the acceptance by a decision. M11-A2 and A3 can start at once and run beside
M10. M11-A4 is last.

## Risks

- A walk-through at the end finds defects late; the sheets and the CI keep the cost of that small, and a defect is a new
  item and not a reason to move the date.
- The deployment of the product owner is behind `main` (migrations of the last weeks are not applied there); A3 starts
  with bringing it to the revision, which is a deployment and is done with the product owner's approval.
- A real service can fail for reasons that are not ours (limits of a free tier, a closed account); the evidence says
  which run it is and what it did not cover.

## Decisions needed from the product owner

- Whether M1 to M5 are in this acceptance as they are (with the open items above), or whether some of them are waived
  or cancelled by a decision now.
- Which revision is the one under acceptance, and whether M10 is built by then.
- Which deployment is the one for A3 (the instance on Vercel, or a Docker deployment with TLS), and when it may be
  brought to the revision.
