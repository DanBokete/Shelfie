-- Email templates: the owner can write "Ask to match" and "Ask for a quote" emails from their own
-- wording, filled in with Shelfie's figures and no AI call, or have Claude write them.
-- A null subject or body means "use the default" (DEFAULT_TEMPLATES in src/lib/templates.ts),
-- so better default wording reaches owners who never changed theirs.

alter table settings
  add column email_writer text not null default 'template'
    check (email_writer in ('template', 'ai')),
  add column match_template_subject text,
  add column match_template_body text,
  add column quote_template_subject text,
  add column quote_template_body text;

-- Which writer made each draft. Null for drafts made before templates existed (all AI).
alter table email_drafts
  add column writer text check (writer in ('template', 'ai'));
