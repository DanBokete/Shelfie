-- Asking a seller found online for a trade quote.

-- How to reach a seller, looked up once by web search the first time the owner asks for a quote.
alter table suppliers
  add column sells_to_trade text check (sells_to_trade in ('yes', 'no', 'unknown')),
  add column contact_source_url text,       -- the page the email or phone was read from
  add column contact_note text,             -- e.g. 'Trade accounts through the Business page'
  add column contact_checked_at timestamptz;

-- Drafts are either "match this price" to a current supplier, or "send us a quote" to a
-- seller found online.
alter table email_drafts
  add column kind text not null default 'match' check (kind in ('match', 'quote')),
  add column price_observation_id uuid references price_observations(id) on delete set null,
  add column to_email text;
