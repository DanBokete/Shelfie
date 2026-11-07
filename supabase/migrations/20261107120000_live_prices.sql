-- Live competitor prices. A price check searches the web for one product; every
-- offer it finds is a price_observations row with source 'web', linked to the check.

-- Competitors are sellers found online. They are never on an invoice.
alter table suppliers
  add column kind text not null default 'supplier' check (kind in ('supplier', 'competitor')),
  add column website text;

create table price_checks (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  offers_found integer not null default 0,
  summary text,                            -- one line from the model, e.g. 'Cheapest at Lidl, 6% under you'
  error text,
  sources jsonb not null default '[]'      -- every page the search looked at [{url, title}]
);

create index price_checks_product_idx on price_checks (product_id, started_at desc);

alter table price_observations drop constraint price_observations_source_check;
alter table price_observations
  add constraint price_observations_source_check check (source in ('invoice', 'price_list', 'web')),
  add column price_check_id uuid references price_checks(id) on delete cascade,
  add column source_url text,              -- the product page the web price came from
  add column observed_at timestamptz not null default now();

alter table price_checks enable row level security;
revoke all on price_checks from anon, authenticated;
grant select, insert, update, delete on price_checks to service_role;

create or replace function reset_demo_data() returns void
language sql security definer set search_path = public as $$
  truncate email_drafts, stock_items, stock_uploads, price_observations, price_checks,
    product_aliases, invoices, products, suppliers restart identity cascade;
$$;
