-- "Connect Gmail": the owner signs in with Google once, and Shelfie sends requests and
-- reads replies through the Gmail API instead of an app password.
-- Not in reset_demo_data or the demo snapshot: a demo reset keeps the Google connection.
create table email_accounts (
  id uuid primary key default gen_random_uuid(),
  provider text not null unique check (provider in ('google')),
  email text not null,
  -- AES-256-GCM with TOKEN_ENCRYPTION_KEY (lib/token-crypto.server.ts). Never sent to the browser.
  refresh_token text not null,
  scopes text[] not null,
  connected_at timestamptz not null default now(),
  -- Google refused the refresh token (revoked, expired): the owner has to connect again.
  needs_reconnect boolean not null default false,
  last_error text
);

alter table email_accounts enable row level security;
revoke all on email_accounts from anon, authenticated;
grant select, insert, update, delete on email_accounts to service_role;

-- A request sent through the Gmail API: its Gmail message and thread. Replies are read
-- from the thread. provider_message_id keeps the RFC Message-ID, as for SMTP.
alter table email_drafts
  add column gmail_message_id text,
  add column gmail_thread_id text;
