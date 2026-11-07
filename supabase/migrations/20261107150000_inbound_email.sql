-- Reading supplier replies. A reply that arrives at the Shelfie inbound address (Postmark
-- webhook) is kept in inbound_emails; quote lines it carries become price_observations
-- with source 'quote'.

create table inbound_emails (
  id uuid primary key default gen_random_uuid(),
  message_id text not null unique,         -- Message-ID header: webhook retries are idempotent
  from_email text not null,
  from_name text,
  subject text,
  body_text text,                          -- plain text of the reply, trimmed
  received_at timestamptz not null default now(),
  -- The request this answers. No foreign key on purpose: email_drafts -> price_observations ->
  -- inbound_emails would be a cycle, and snapshot restore inserts tables in one fixed order.
  draft_id uuid,
  supplier_id uuid references suppliers(id) on delete set null,
  match_method text check (match_method in ('plus_address', 'sender_email', 'sender_domain', 'manual')),
  status text not null default 'received'
    check (status in ('received', 'processed', 'failed', 'unmatched')),
  error text,
  attachments jsonb not null default '[]', -- [{name, type, size, path}] stored in the invoices bucket
  invoices_read integer not null default 0,
  quote_lines integer not null default 0,
  better_quotes integer not null default 0
);

create index inbound_emails_received_idx on inbound_emails (received_at desc);

alter table price_observations drop constraint price_observations_source_check;
alter table price_observations
  add constraint price_observations_source_check
    check (source in ('invoice', 'price_list', 'web', 'quote')),
  add column inbound_email_id uuid references inbound_emails(id) on delete cascade;

create index price_observations_inbound_idx on price_observations (inbound_email_id);

alter table inbound_emails enable row level security;
revoke all on inbound_emails from anon, authenticated;
grant select, insert, update, delete on inbound_emails to service_role;

create or replace function reset_demo_data() returns void
language sql security definer set search_path = public as $$
  truncate email_drafts, stock_items, stock_uploads, price_observations, price_checks,
    inbound_emails, product_aliases, invoices, products, suppliers restart identity cascade;
$$;
