# Next batch plan: late-arrival outreach (as of 2026-11-28)

Handoff notes for picking this up on another machine. Prospect names and replies stay in
GHL, not here (this repo is public).

## Where the first batch landed

- 234 Tier A contacts got the "pre-registration at {company}" sequence, Nov 9-26.
- 9 people replied plus 2 auto-replies (out of office, closed for the season), about 4%.
  Of the 9: 5 engaged, 2 said "we have it covered", 2 asked to be removed (now DND).
- The word "pre-registration" confused people. One asked outright what it means; others
  answered as if we had asked "how do you reach OTA guests?" and ignored it.
- On Nov 28 the three unanswered engaged replies got one-to-one answers. Check for responses.

## How to find replies

Use Conversations > Filter > Last Message Direction = Inbound. It lists every thread
where the prospect spoke last. Don't rely on the "Cloudbeds Late Arrival - reply alert"
workflow: it missed a real reply and both auto-replies.

## Proposed sequence for the next batch

Lead with the night-of problem in the owner's words, not our feature name. Style rules
unchanged: short, question-led, no links, no call ask, no em-dashes.

Subject (same on all three so they thread): `late arrivals at {company}`

**Email 1**

> Hi {first_name},
>
> Quick question. When a Booking.com or Expedia guest arrives after your desk has closed
> and never got the door code, who ends up taking that call?

**Email 2** (about 3 days later)

> Following up on my note. A lot of owners I talk to can't reach those guests ahead of
> time, because Booking.com and Expedia hide their real email and phone. Is that something
> you run into, or do you usually get through to them?

**Email 3** (about 5 days later)

> Last one from me. Do you keep someone on overnight to cover late arrivals, or does it
> end up falling to you?

## Fix before sending

1. **Greeting.** Contacts with no name have first name "there", so emails read
   "Hi There,". Use "Hi," as the fallback, or clear the field on import.
2. **Targeting.** Skip contacts tagged has-24h-desk. Best fit is small independents,
   roughly under 50 rooms, that close the desk at night.
3. **Auto-links.** GHL turns "Booking.com" into a link. Check the source view and strip it.
4. **Holidays.** Email 2 went out on Thanksgiving. Uncheck holiday days in the send window
   and all three wait steps.
5. **Test first.** Load the copy into "TEST - Late Arrival 3 emails", send to the test
   contact, and confirm all three land in Gmail Primary before changing the live workflow.

`outreach-copy.json` holds the older phone-booking pitch and is out of date; don't reuse it.
