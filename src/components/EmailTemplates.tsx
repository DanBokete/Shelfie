// Settings: who writes request emails, and the owner's own templates with a live preview.
// The preview uses the same renderTemplate as the server, so it matches the email window.
import { useRef, useState } from 'react'
import { Icon } from './Icon'
import {
  DEFAULT_TEMPLATES,
  EMAIL_PLACEHOLDERS,
  ITEM_PLACEHOLDERS,
  PLACEHOLDER_HELP,
  renderTemplate,
  sampleFacts,
  templateProblems,
} from '#/lib/templates'
import type { EmailKind, EmailTemplate, Writer } from '#/lib/templates'

export interface TemplatesForm {
  email_writer: Writer
  match_template_subject: string
  match_template_body: string
  quote_template_subject: string
  quote_template_body: string
}

const KINDS: Array<{ kind: EmailKind; label: string; hint: string }> = [
  {
    kind: 'match',
    label: 'Ask to match',
    hint: 'To a supplier you buy from. The default wording asks for a price and never names the other seller or what you pay now.',
  },
  {
    kind: 'quote',
    label: 'Ask for a quote',
    hint: 'To a seller found online. Never shows your current supplier or what you pay.',
  },
]

export function templateOf(f: TemplatesForm, kind: EmailKind): EmailTemplate {
  return {
    subject: f[`${kind}_template_subject`],
    body: f[`${kind}_template_body`],
  }
}

/** True when both templates can be saved. */
export function templatesValid(f: TemplatesForm): boolean {
  return KINDS.every(
    ({ kind }) => templateProblems(kind, templateOf(f, kind)).length === 0,
  )
}

export function EmailWriting({
  form,
  business,
  replyByDays,
  onChange,
}: {
  form: TemplatesForm
  business: { business_name: string; owner_name: string; town: string }
  replyByDays: number
  onChange: (patch: Partial<TemplatesForm>) => void
}) {
  const [kind, setKind] = useState<EmailKind>('match')
  const tpl = templateOf(form, kind)
  const problems = templateProblems(kind, tpl)
  const preview = renderTemplate(
    kind,
    tpl,
    sampleFacts(
      kind,
      business,
      Number.isFinite(replyByDays) && replyByDays > 0 ? replyByDays : 7,
    ),
  )
  const isDefault =
    tpl.subject === DEFAULT_TEMPLATES[kind].subject &&
    tpl.body === DEFAULT_TEMPLATES[kind].body

  const subjectRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  // Where a placeholder chip inserts: the field last typed in, at its cursor.
  const lastField = useRef<'subject' | 'body'>('body')

  const set = (part: keyof EmailTemplate, value: string) =>
    onChange({ [`${kind}_template_${part}`]: value })

  function insert(name: string, inItems: boolean) {
    const part = inItems ? 'body' : lastField.current
    const el = part === 'subject' ? subjectRef.current : bodyRef.current
    const token = `{${name}}`
    const value = tpl[part]
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    set(part, value.slice(0, start) + token + value.slice(end))
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + token.length, start + token.length)
    })
  }

  const meta = KINDS.find((k) => k.kind === kind)!

  return (
    <>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Write emails with</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <WriterOption
            checked={form.email_writer === 'template'}
            onSelect={() => onChange({ email_writer: 'template' })}
            title="Template"
            hint="Instant, no AI. Your wording below, with Shelfie’s figures."
          />
          <WriterOption
            checked={form.email_writer === 'ai'}
            onSelect={() => onChange({ email_writer: 'ai' })}
            title="AI (Claude)"
            hint="Claude writes each email from the same figures. Needs an API key."
          />
        </div>
        <p className="text-xs text-muted">
          You can switch any single email the other way in the email window.
        </p>
      </fieldset>

      <div className="space-y-4 border-t border-line pt-4">
        <div
          role="tablist"
          aria-label="Template"
          className="flex gap-1 rounded-full bg-soft p-1"
        >
          {KINDS.map((k) => {
            const bad =
              templateProblems(k.kind, templateOf(form, k.kind)).length > 0
            return (
              <button
                key={k.kind}
                role="tab"
                aria-selected={k.kind === kind}
                onClick={() => setKind(k.kind)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                  k.kind === kind
                    ? 'bg-card text-ink shadow-sm'
                    : 'text-muted hover:text-ink'
                }`}
              >
                {k.label}
                {bad && (
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-rust"
                    aria-label="has problems"
                  />
                )}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted">{meta.hint}</p>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Subject</span>
          <input
            ref={subjectRef}
            className="input"
            value={tpl.subject}
            maxLength={300}
            onFocus={() => (lastField.current = 'subject')}
            onChange={(e) => set('subject', e.target.value)}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Message</span>
          <textarea
            ref={bodyRef}
            className="input min-h-80 resize-y leading-relaxed [field-sizing:content]"
            value={tpl.body}
            maxLength={5000}
            spellCheck
            onFocus={() => (lastField.current = 'body')}
            onChange={(e) => set('body', e.target.value)}
          />
        </label>

        {problems.length > 0 && (
          <ul
            role="alert"
            className="space-y-1 rounded-lg bg-rust-soft px-3 py-2.5 text-sm text-rust"
          >
            {problems.map((p) => (
              <li key={`${p.field}:${p.message}`} className="flex gap-2">
                <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {p.field === 'subject' ? 'Subject: ' : ''}
                  {p.message}
                </span>
              </li>
            ))}
          </ul>
        )}

        <Placeholders kind={kind} onInsert={insert} />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted">
            {isDefault ? 'Using the default wording.' : 'Your own wording.'}
          </p>
          <button
            type="button"
            className="btn-ghost"
            disabled={isDefault}
            onClick={() =>
              onChange({
                [`${kind}_template_subject`]: DEFAULT_TEMPLATES[kind].subject,
                [`${kind}_template_body`]: DEFAULT_TEMPLATES[kind].body,
              })
            }
          >
            Reset to default
          </button>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">
            Preview{' '}
            <span className="font-normal text-muted">with sample figures</span>
          </p>
          <div className="overflow-hidden rounded-lg border border-line bg-bg/60">
            <p className="border-b border-line px-4 py-2.5 text-sm">
              <span className="text-muted">Subject: </span>
              <span className="font-medium break-words">
                {preview.subject || '(empty)'}
              </span>
            </p>
            <pre className="px-4 py-3 font-sans text-sm leading-relaxed break-words whitespace-pre-wrap">
              {preview.body}
            </pre>
          </div>
        </div>
      </div>
    </>
  )
}

function WriterOption({
  checked,
  onSelect,
  title,
  hint,
}: {
  checked: boolean
  onSelect: () => void
  title: string
  hint: string
}) {
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
        checked
          ? 'border-brand bg-brand-soft/60'
          : 'border-line bg-card hover:bg-soft/50'
      }`}
    >
      <input
        type="radio"
        name="email_writer"
        className="mt-1 accent-brand"
        checked={checked}
        onChange={onSelect}
      />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
    </label>
  )
}

function Placeholders({
  kind,
  onInsert,
}: {
  kind: EmailKind
  onInsert: (name: string, inItems: boolean) => void
}) {
  const chip = (name: string, inItems: boolean) => (
    <button
      key={name}
      type="button"
      title={PLACEHOLDER_HELP[name as keyof typeof PLACEHOLDER_HELP]}
      aria-label={`Insert {${name}}`}
      onClick={() => onInsert(name, inItems)}
      className="rounded-md border border-line bg-card px-1.5 py-0.5 font-mono text-xs text-ink hover:border-ink"
    >
      {`{${name}}`}
    </button>
  )
  return (
    <details className="rounded-lg border border-line bg-bg/60 px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium">
        Placeholders{' '}
        <span className="font-normal text-muted">tap one to insert it</span>
      </summary>
      <div className="mt-3 space-y-3">
        <div className="space-y-1.5">
          <p className="text-xs text-muted">Anywhere in the email:</p>
          <div className="flex flex-wrap gap-1.5">
            {EMAIL_PLACEHOLDERS.map((p) => chip(p, false))}
          </div>
        </div>
        <div className="space-y-1.5">
          <p className="text-xs text-muted">
            Once per product, on the lines between <Code>{'{items}'}</Code> and{' '}
            <Code>{'{/items}'}</Code> (each on a line of its own):
          </p>
          <div className="flex flex-wrap gap-1.5">
            {ITEM_PLACEHOLDERS[kind].map((p) => chip(p, true))}
          </div>
        </div>
        <ul className="list-disc space-y-1 pl-4 text-xs text-muted">
          {[...EMAIL_PLACEHOLDERS, ...ITEM_PLACEHOLDERS[kind]].map((p) => (
            <li key={p}>
              <Code>{`{${p}}`}</Code>: {PLACEHOLDER_HELP[p]}
            </li>
          ))}
          <li>
            A line whose value is missing, such as a weekly quantity Shelfie
            doesn’t know, is left out of the email.
          </li>
        </ul>
      </div>
    </details>
  )
}

function Code({ children }: { children: string }) {
  return <code className="font-mono text-[0.85em] text-ink">{children}</code>
}
