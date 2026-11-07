-- Shelfie schema. Every price the app knows is one row in price_observations.
-- All access goes through server code with the service role key, so RLS is
-- enabled on every table with no policies: the anon key can read nothing.

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid references suppliers(id),
  invoice_date date,
  invoice_number text,
  file_name text,
  file_path text not null,
  status text not null default 'uploaded', -- uploaded | extracting | done | failed | duplicate
  error text,
  confidence numeric,                      -- 0 to 1, from the model
  raw_json jsonb,                          -- full model output, for debugging
  created_at timestamptz default now()
);

create table products (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,            -- e.g. 'Whole milk 2L'
  brand text,
  barcode text unique,                     -- EAN-13 when known
  category text,                           -- dairy, bakery, drinks, dry goods...
  base_unit text not null check (base_unit in ('ml', 'g', 'each'))
);

create table product_aliases (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete cascade,
  supplier_id uuid references suppliers(id) on delete cascade,
  raw_text text not null,                  -- e.g. 'AVONM WHL 2LTR'
  confirmed boolean not null default false,
  unique nulls not distinct (supplier_id, raw_text)
);

create table price_observations (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete set null,
  supplier_id uuid references suppliers(id),
  invoice_id uuid references invoices(id) on delete cascade,
  line_index integer,                      -- position on the invoice
  raw_description text not null,
  quantity numeric,                        -- packs bought (invoice) or null (price list)
  pack_price numeric not null,             -- EUR excluding VAT, per pack
  line_total numeric,
  pack_size numeric,                       -- e.g. 2000
  pack_unit text,                          -- 'ml' | 'g' | 'each'
  units_per_case integer default 1,        -- e.g. a case of 12
  price_per_base_unit numeric,             -- computed by lib/units.ts
  observed_on date not null,
  source text not null check (source in ('invoice', 'price_list')),
  extraction_confidence numeric,           -- 0 to 1
  match_confidence numeric,                -- 0 to 1
  match_reason text,
  needs_review boolean default false,
  review_reasons text[] not null default '{}'
);

create index price_observations_product_idx on price_observations (product_id, supplier_id, observed_on desc);
create index price_observations_invoice_idx on price_observations (invoice_id);

create table stock_uploads (
  id uuid primary key default gen_random_uuid(),
  file_name text,
  column_mapping jsonb,
  status text default 'uploaded',
  total_annual_saving numeric,
  report jsonb,
  created_at timestamptz default now()
);

create table stock_items (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid references stock_uploads(id) on delete cascade,
  raw_name text not null,
  raw_quantity text,
  raw_unit text,
  raw_price text,
  raw_supplier text,
  weekly_quantity numeric,                 -- packs per week, normalised
  pack_spec jsonb,                         -- what one counted unit holds {pack_size, pack_unit, units_per_case}
  product_id uuid references products(id) on delete set null,
  match_confidence numeric,
  finding_group text,
  annual_saving numeric
);

create table email_drafts (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid references suppliers(id) on delete cascade,
  subject text,
  body text,
  items jsonb,
  status text default 'draft',             -- draft | approved | sent
  created_at timestamptz default now()
);

-- Latest price per product per supplier
create view latest_prices with (security_invoker = true) as
select distinct on (product_id, supplier_id)
  product_id, supplier_id, pack_price, pack_size, pack_unit,
  units_per_case, price_per_base_unit, observed_on, source
from price_observations
where product_id is not null and price_per_base_unit is not null
order by product_id, supplier_id, observed_on desc;

alter table suppliers enable row level security;
alter table invoices enable row level security;
alter table products enable row level security;
alter table product_aliases enable row level security;
alter table price_observations enable row level security;
alter table stock_uploads enable row level security;
alter table stock_items enable row level security;
alter table email_drafts enable row level security;

-- Private bucket for uploaded invoice files
insert into storage.buckets (id, name, public) values ('invoices', 'invoices', false)
on conflict (id) do nothing;

-- Wipes all business data in one statement (used by /admin/reset)
create or replace function reset_demo_data() returns void
language sql security definer set search_path = public as $$
  truncate email_drafts, stock_items, stock_uploads, price_observations,
    product_aliases, invoices, products, suppliers restart identity cascade;
$$;
revoke execute on function reset_demo_data() from public, anon, authenticated;

-- Server code uses the service role. Grant it explicitly; anon and authenticated get nothing.
revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant execute on function reset_demo_data() to service_role;
