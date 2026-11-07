-- Telegram alerts to the owner. Every send is recorded, including failed and unconfigured ones,
-- so the same deal is never sent twice and a failure can be seen afterwards.

create table alerts_sent (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('better_quote', 'web_price', 'weekly', 'test')),
  key text not null,                      -- what the alert is about, e.g. product:supplier:price
  sent_at timestamptz not null default now(),
  text text not null,                     -- the message exactly as sent
  ok boolean,                             -- null while sending, then true or false
  error text
);

-- One alert per deal: a send in progress or done claims the key. A failed one does not,
-- so the same deal can be tried again later. Weekly and test messages can be re-sent.
create unique index alerts_sent_once_idx on alerts_sent (kind, key)
  where ok is not false and kind in ('better_quote', 'web_price');
create index alerts_sent_sent_at_idx on alerts_sent (sent_at desc);

alter table alerts_sent enable row level security;
revoke all on alerts_sent from anon, authenticated;
grant select, insert, update, delete on alerts_sent to service_role;

create or replace function reset_demo_data() returns void
language sql security definer set search_path = public as $$
  truncate email_drafts, stock_items, stock_uploads, price_observations, price_checks,
    inbound_emails, product_aliases, invoices, products, suppliers, alerts_sent
    restart identity cascade;
$$;
