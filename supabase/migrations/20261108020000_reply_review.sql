-- Reviewing supplier replies. A reply no longer changes prices on its own: what it proposes
-- waits here until the owner applies it.
--
-- - reply_lines: each price a reply proposes (read from a quote or price list, made from a
--   "yes" to a match request, or added by hand). Nothing here reaches savings, audits, price
--   checks or alerts: only applying a line writes a price_observations row.
-- - reply_invoices: an invoice attached to a reply, added to Invoices only when the owner says.
-- - request_outcomes: what the supplier answered, per reply and per requested product.
-- - price_observations.source 'agreed': a price the supplier agreed to (accepted or countered)
--   and the owner applied. It counts as what the owner pays that supplier until a newer
--   invoice from them (lib/savings.ts).

alter table price_observations drop constraint price_observations_source_check;
alter table price_observations
  add constraint price_observations_source_check
    check (source in ('invoice', 'price_list', 'web', 'quote', 'agreed'));

create table reply_lines (
  id uuid primary key default gen_random_uuid(),
  inbound_email_id uuid not null references inbound_emails(id) on delete cascade,
  -- The request the reply answers, and which of its items this line is about (index into
  -- email_drafts.items). No foreign key, as for inbound_emails.draft_id.
  draft_id uuid,
  request_item integer,
  -- 'email body', or the attachment's file name.
  source text not null default 'email body',
  origin text not null check (origin in ('read', 'accepted', 'manual')),
  line_index integer not null default 0,
  raw_description text not null,
  pack_price numeric not null check (pack_price > 0), -- EUR ex VAT, per pack
  pack_size numeric check (pack_size > 0),
  pack_unit text check (pack_unit in ('ml', 'cl', 'l', 'g', 'kg', 'each')),
  units_per_case integer not null default 1 check (units_per_case > 0),
  observed_on date not null,
  extraction_confidence numeric,
  -- The suggested product. When the matcher found none, new_product_name is what applying
  -- creates: nothing is created or remembered before the owner applies the line.
  product_id uuid references products(id) on delete set null,
  new_product_name text,
  new_product_unit text check (new_product_unit in ('ml', 'g', 'each')),
  match_method text,
  match_confidence numeric,
  match_reason text,
  review_reasons text[] not null default '{}',
  status text not null default 'proposed'
    check (status in ('proposed', 'applied', 'rejected')),
  decided_at timestamptz,
  -- What applying added, so undo takes back exactly that.
  applied_observation_id uuid references price_observations(id) on delete set null,
  created_product_id uuid references products(id) on delete set null,
  created_alias boolean not null default false,
  created_at timestamptz not null default now()
);

create index reply_lines_inbound_idx on reply_lines (inbound_email_id);
create index reply_lines_proposed_idx on reply_lines (status) where status = 'proposed';

create table reply_invoices (
  id uuid primary key default gen_random_uuid(),
  inbound_email_id uuid not null references inbound_emails(id) on delete cascade,
  name text not null,
  type text not null,
  path text not null,                      -- in the invoices bucket (inbound/<reply id>/...)
  status text not null default 'proposed'
    check (status in ('proposed', 'applied', 'rejected')),
  decided_at timestamptz,
  invoice_id uuid references invoices(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (inbound_email_id, path)
);

create table request_outcomes (
  id uuid primary key default gen_random_uuid(),
  inbound_email_id uuid not null references inbound_emails(id) on delete cascade,
  draft_id uuid,
  -- Index into email_drafts.items; null for the reply as a whole.
  request_item integer,
  product_id uuid references products(id) on delete set null,
  outcome text not null
    check (outcome in ('accepted', 'counter_offer', 'declined', 'needs_info', 'unclear')),
  -- The price offered, for a counter-offer, EUR ex VAT per pack.
  pack_price numeric,
  pack_size numeric,
  pack_unit text check (pack_unit in ('ml', 'cl', 'l', 'g', 'kg', 'each')),
  units_per_case integer,
  said text,                               -- the supplier's own words about it
  question text,                           -- what they asked, for needs_info
  set_by text not null default 'reader' check (set_by in ('reader', 'owner')),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (inbound_email_id, request_item)
);

create index request_outcomes_draft_idx on request_outcomes (draft_id);

-- Prices replies added before review existed were never approved: move them into review.
-- A product the reader created from such a line (named after the line, used by nothing else,
-- never confirmed by the owner) goes, and becomes the line's suggested new product.
create temporary table made_products on commit drop as
select distinct p.id, p.base_unit
from price_observations o
join products p on p.id = o.product_id and p.canonical_name = o.raw_description
where o.source = 'quote' and o.inbound_email_id is not null
  and not exists (
    select 1 from price_observations x where x.product_id = p.id and x.id <> o.id
  )
  and not exists (
    select 1 from product_aliases a where a.product_id = p.id and a.confirmed
  )
  and not exists (select 1 from stock_items x where x.product_id = p.id)
  and not exists (select 1 from price_checks x where x.product_id = p.id);

insert into reply_lines (
  inbound_email_id, draft_id, source, origin, line_index, raw_description, pack_price,
  pack_size, pack_unit, units_per_case, observed_on, extraction_confidence, product_id,
  new_product_name, new_product_unit, match_confidence, match_reason, review_reasons
)
select o.inbound_email_id, e.draft_id, 'email body', 'read', coalesce(o.line_index, 0),
  o.raw_description, o.pack_price,
  case when o.pack_size > 0 then o.pack_size end,
  case when o.pack_unit in ('ml', 'cl', 'l', 'g', 'kg', 'each') then o.pack_unit end,
  greatest(coalesce(o.units_per_case, 1), 1), o.observed_on, o.extraction_confidence,
  case when m.id is null then o.product_id end,
  case when m.id is not null then o.raw_description end,
  m.base_unit, o.match_confidence, o.match_reason,
  array(select r from unnest(o.review_reasons) r
        where r not like 'Match:%' and r not like 'Unit mismatch%')
from price_observations o
join inbound_emails e on e.id = o.inbound_email_id
left join made_products m on m.id = o.product_id
where o.source = 'quote' and o.inbound_email_id is not null and o.pack_price > 0;

-- The aliases the reader saved for those lines were never confirmed by the owner.
delete from product_aliases a
using price_observations o
where o.source = 'quote' and o.inbound_email_id is not null
  and a.supplier_id = o.supplier_id and a.raw_text = o.raw_description
  and not a.confirmed;

delete from price_observations where source = 'quote' and inbound_email_id is not null;

delete from products p using made_products m where p.id = m.id;

alter table reply_lines enable row level security;
alter table reply_invoices enable row level security;
alter table request_outcomes enable row level security;
revoke all on reply_lines, reply_invoices, request_outcomes from anon, authenticated;
grant select, insert, update, delete on reply_lines, reply_invoices, request_outcomes
  to service_role;

create or replace function reset_demo_data() returns void
language sql security definer set search_path = public as $$
  truncate email_drafts, stock_items, stock_uploads, request_outcomes, reply_invoices,
    reply_lines, price_observations, price_checks, inbound_emails, product_aliases, invoices,
    products, suppliers, alerts_sent
    restart identity cascade;
$$;
