-- A Telegram alert when an invoice charges more than a price the supplier agreed in a reply
-- (lib/alerts.server.ts notifyNotHonoured). Sent once per product, supplier, agreement and
-- invoice, like the other deal alerts.

alter table alerts_sent drop constraint alerts_sent_kind_check;
alter table alerts_sent
  add constraint alerts_sent_kind_check
    check (kind in ('better_quote', 'web_price', 'weekly', 'test', 'reply', 'not_honoured'));

drop index alerts_sent_once_idx;
create unique index alerts_sent_once_idx on alerts_sent (kind, key)
  where ok is not false and kind in ('better_quote', 'web_price', 'reply', 'not_honoured');
