-- Sending requests from Shelfie itself instead of the owner's mail app.
-- "if not exists": this ran under an earlier version number on some local databases.

-- The address emails come from: the owner's Gmail account, or a Postmark sender.
alter table settings add column if not exists from_email text;

-- What happened when a draft was sent.
alter table email_drafts
  add column if not exists sent_at timestamptz,
  add column if not exists provider_message_id text,   -- Gmail or Postmark message id
  add column if not exists send_error text;
