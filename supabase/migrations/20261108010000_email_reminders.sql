-- Reminders: a short follow-up to a request that got no reply, sent as a reply in the same
-- email thread. A reminder is its own email_drafts row (draft, send error and sent time as
-- for any request) that points at the request it follows up.
-- Replies are tied to the original request, never to a reminder: the reply reader watches only
-- original requests, and a reminder CCs the original's reply address.
--
-- No foreign key on purpose, as for inbound_emails.draft_id: snapshot restore inserts the rows
-- of a table in id order, so a reminder could come before the request it points at.
alter table email_drafts
  add column follow_up_of uuid;

create index email_drafts_follow_up_idx on email_drafts (follow_up_of)
  where follow_up_of is not null;
