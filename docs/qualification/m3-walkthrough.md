# Walkthrough of the operator and the customer

Evidence for P6-A3 of [the completion plan](../plans/m4-completion.md) (M3-A7, M3-A10, M3-A11).
Date of the walkthrough: 2026-10-16, on the development stack, in Chromium, Firefox and WebKit as
Playwright drives them. It has two parts: a scripted one that stays in the repository as
[`tests/e2e/walkthrough.spec.ts`](../../tests/e2e/walkthrough.spec.ts), and a part that was looked at
by reading screenshots of the pages (the operator's ticket in German with a dark system, at 1280 px
and at 360 px, and the settings).

## What was covered

- **Languages and appearance.** The operator works a ticket in German with a dark system (the
  overview, the ticket with its tools opened, the composer, the settings); the rules of the scanner
  (WCAG 2.2 A and AA) find nothing on any of these views. The English views in light and dark were
  already part of `accessibility.spec.ts`.
- **A narrow window and zoom.** At 320 px and at 640 px (200 % of a 1280 px window) the overview,
  the ticket, the settings and the customer's page do not scroll sideways, and the scanner finds
  nothing there either.
- **The keyboard alone.** From the first Tab, the focus is always drawn (an outline), the navigation
  with Inbox, Settings and Sign out is reached in order, a ticket is opened with Enter and a note is
  typed, the dialog of a new project keeps the focus inside and gives it back to the button that
  opened it. In WebKit this test is skipped: Safari does not move the focus to buttons with Tab
  unless its setting says so.
- **The console.** The desk and the customer's page open without an error in the console of the
  browser, in all three.

## What was found and fixed

1. **The tools of a ticket made the header overflow** (found on the screenshot): with the assignee,
   the knowledge search and the issues next to the portal link, the tags and the reminder, the buttons
   ran out of the panel on the right and the conversation had almost no room. The tools now have a
   row of their own under the title, are smaller, and share rows; an opened panel takes the whole row.
2. **The checkbox for the knowledge sources grew to a grey square** of 200 px, because a rule for the
   field of the instruction applied to every input of that row.
3. **Two children with the same key** in the header of a ticket (the portal link, the tags and the
   issues were all keyed by the ticket); React logged an error on every ticket. One of the two had
   been there before this work. Each now has its own key.
4. **The customer's page failed to hydrate in Firefox and WebKit**: the server writes the time of a
   message in UTC and the browser in its own zone, and React threw the page away and drew it again.
   The time is now marked as differing on purpose, and the browser's zone is what the customer sees.

## What is not covered

- **A screen reader.** None is available to drive here. The scanner checks names, roles and
  relations; it cannot tell whether a page is understandable when read aloud. This needs a person
  with VoiceOver or NVDA and stays open.
- **Safari's own keyboard model** (see above), and the visual judgement of a person: the
  screenshots were read for overflow and broken layout, not for taste.
- **One message in the console of the development stack**, "Blocked script execution in
  'about:srcdoc' ... sandboxed", appears on the settings page where the mail design is previewed. The
  previewed text holds no script (checked), the frame is sandboxed on purpose, and I did not find who
  asks it to run one; the test leaves this one message out.
- **Custom domains for the customer page** are not built; the decision about the domain is still
  open.
