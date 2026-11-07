-- One Telegram message for every supplier reply, keyed by the reply (inbound_emails.id), so
-- reading it again or checking Gmail again never sends it twice. A better quote in a reply is
-- part of that message: 'better_quote' rows are now only recorded, one per deal, never sent.
-- The table already has RLS on with no policies and service_role grants (20261107170000).

alter table alerts_sent drop constraint alerts_sent_kind_check;
alter table alerts_sent
  add constraint alerts_sent_kind_check
    check (kind in ('better_quote', 'web_price', 'weekly', 'test', 'reply'));

-- A reply message in progress or sent claims its key; a failed one can be tried again.
drop index alerts_sent_once_idx;
create unique index alerts_sent_once_idx on alerts_sent (kind, key)
  where ok is not false and kind in ('better_quote', 'web_price', 'reply');
