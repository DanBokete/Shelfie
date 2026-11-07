-- How request emails are sent: through the owner's own Gmail account (an app password in
-- .env), or through Postmark (needs a verified domain, so not for @gmail.com addresses).
-- "if not exists": this ran under an earlier version number on some local databases.
alter table settings
  add column if not exists send_via text not null default 'gmail'
    check (send_via in ('gmail', 'postmark'));
