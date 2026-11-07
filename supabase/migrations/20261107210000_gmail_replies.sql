-- Reading supplier replies from the owner's Gmail (IMAP, the same app password used to send)
-- instead of a Postmark inbound webhook. Shows on Settings when Gmail was last checked.
alter table settings
  add column if not exists replies_checked_at timestamptz,
  add column if not exists replies_check_error text;

-- Gmail message ids of sent requests are already kept in email_drafts.provider_message_id;
-- a reply names it in In-Reply-To or References, which ties the reply to its request.
create index if not exists email_drafts_sent_idx on email_drafts (sent_at desc) where sent_at is not null;
