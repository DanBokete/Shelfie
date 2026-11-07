-- Owner settings for emails and reply scanning, edited on /settings. Exactly one row.
-- Null inbound_address / webhook_secret fall back to INBOUND_EMAIL_ADDRESS /
-- INBOUND_WEBHOOK_SECRET in .env. Not business data: reset and snapshots leave it alone.

create table settings (
  id boolean primary key default true check (id),
  -- Used in the emails Claude drafts
  business_name text not null default 'The Corner Café',
  owner_name text not null default 'Aoife',
  town text not null default 'Cork',
  -- Sending requests
  reply_by_days integer not null default 7 check (reply_by_days between 1 and 60),
  cc_shelfie boolean not null default true,
  bcc_email text,
  -- Reading replies
  reply_scanning boolean not null default true,
  inbound_address text,
  webhook_secret text,
  match_by_sender boolean not null default true,
  -- Better-quote alerts
  alerts_enabled boolean not null default true,
  alert_min_saving numeric not null default 0 check (alert_min_saving >= 0),
  updated_at timestamptz not null default now()
);

insert into settings default values;

alter table settings enable row level security;
revoke all on settings from anon, authenticated;
grant select, insert, update on settings to service_role;
