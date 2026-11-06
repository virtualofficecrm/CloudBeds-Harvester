# GHL AI workflow-builder prompt: Cloudbeds pilot outreach

Architecture: ONE template (a fixed shell), ONE workflow, no branches. All
verbiage lives in `outreach-copy.json` on the Cloudflare side and is injected
into contact custom fields (email_subject, personal_hook, email_body_1/2/3).
Segment differences (main vs desk) and follow-up messages are just different
field values, written by our code. Between message 1 and message 2 the
workflow calls our worker via webhook; the worker rewrites the fields and
answers with a tag, and the workflow waits for that tag before sending again.
The shell template is never edited after creation.

Paste the block below into GHL's AI workflow builder, then verify the list at
the bottom by hand.

---

Create a cold email outreach workflow with these exact requirements:

TRIGGER: Contact Tag Added, where the tag equals "cb-pilot-send".

ENTRY CONDITIONS: Only allow contacts into the workflow if ALL of these are
true: the contact has an email address, the contact has the tag "cloudbeds",
the custom field "email_subject" is not empty, the custom field
"personal_hook" is not empty, and the custom field "email_body_1" is not
empty.

STEP 1: Send an email using my saved template named "Cloudbeds Pilot
Outreach". Send it from "Chris Russo" at chris@mg.virtualofficecrm.com.

STEP 2: Add the tag "cb-pilot-sent" to the contact, then wait 4 days.

STEP 3: Send a webhook (POST) to my external URL. I will paste the URL and a
custom header when building this step. Include the contact's ID, email, and
tags in the payload.

STEP 4: Wait until the contact has the tag "msg-2-ready", with a maximum
wait of 3 days. If the tag never arrives, end the workflow.

STEP 5: Send an email using the SAME template "Cloudbeds Pilot Outreach",
again from "Chris Russo" at chris@mg.virtualofficecrm.com. (The custom
fields now contain the follow-up message, so the same template renders
message 2.)

STEP 6: Add the tag "cb-followup-sent" and end the workflow.

WORKFLOW SETTINGS:
- If the contact replies at any point, immediately remove them from the
  workflow and add the tag "cb-replied".
- Contacts must never re-enter this workflow (disable re-entry).
- Only send emails Tuesday through Thursday, between 10:00 AM and 2:00 PM in
  the contact's timezone; if the contact has no timezone, use the account
  timezone. This applies to BOTH send steps.
- Respect DND: never email a contact marked Do Not Disturb for email.

---

## Verify manually after generation

1. The template's **subject field** is exactly `{{contact.email_subject}}`
   and Preview Text is `{{contact.personal_hook}}`.
2. **Stop on response** is ON at the workflow level (a reply removes the
   contact before the wait ends, so message 2 never sends to a replier).
3. **Re-entry** is OFF.
4. The **time window** (Tue-Thu, 10am-2pm, contact's timezone) is attached
   to BOTH send steps.
5. **From Name/Email** ("Chris Russo" / chris@mg.virtualofficecrm.com) is set
   on BOTH send steps. The dedicated-domain header is cleared, so per-step
   From values are what actually apply.
6. The **webhook step** has the worker URL and the x-auth header (get both
   from Chris/Claude at build time; the endpoint is part of the worker).
7. The **wait-for-tag step** waits on "msg-2-ready" with a timeout, so a
   webhook failure ends the workflow instead of stalling contacts forever.

## Segments and send order

Every confirmed Cloudbeds contact gets emailed. The has-24h-desk segment
gets different copy (injected into the same fields by our code), not a
different workflow path. Send order is controlled by which contacts you tag:
tier-a first, then tier-b, then the has-24h-desk batch once early reply data
is in. The field writer records the subject variant as tags subj-1/2/3 and
the message number as msg-1 / msg-2, so reply rates are filterable by
variant and by touch.

## Not in the workflow (deliberate)

- **Throttling is not a workflow step.** Apply the cb-pilot-send tag in
  daily batches of 25-40, or bulk-add with drip mode at ~30/day. Never tag
  all 250 at once; the sending domain is still warming.
- **Tagging is manual by design.** Nothing automated applies cb-pilot-send;
  it is the human arming switch after the subject and hook columns have been
  reviewed.
- **Copy changes never touch GHL.** Edit outreach-copy.json, re-run the
  field writer, done. The template shell and this workflow stay frozen.
