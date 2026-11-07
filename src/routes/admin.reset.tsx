import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { Icon, Spinner } from '#/components/Icon'
import { adminAction, getAdminStatus } from '#/server/fns'

export const Route = createFileRoute('/admin/reset')({
  loader: () => getAdminStatus(),
  component: AdminReset,
  head: () => ({
    meta: [
      { title: 'Demo reset - Shelfie' },
      { name: 'robots', content: 'noindex' },
    ],
  }),
})

type Action = 'restore' | 'wipe' | 'snapshot'

function AdminReset() {
  const status = Route.useLoaderData()
  const router = useRouter()
  const [busy, setBusy] = useState<Action | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  )

  async function act(action: Action) {
    if (
      action === 'wipe' &&
      !window.confirm(
        'Delete every invoice, product and price? This cannot be undone.',
      )
    )
      return
    if (
      action === 'snapshot' &&
      !window.confirm('Replace the saved demo snapshot with the current data?')
    )
      return
    setBusy(action)
    setResult(null)
    try {
      const r = await adminAction({ data: { action } })
      const counts = Object.entries(r.counts)
        .map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`)
        .join(', ')
      setResult({
        ok: true,
        text:
          action === 'wipe'
            ? 'Everything deleted.'
            : action === 'restore'
              ? `Restored: ${counts}.`
              : `Snapshot saved: ${counts}.`,
      })
      await router.invalidate()
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : 'Failed' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Demo reset</h1>
        <p className="mt-1 text-muted">
          Put the demo back to its starting point before every rehearsal and
          before going on stage.
        </p>
      </div>

      <button
        className="btn-primary w-full py-5 text-lg"
        disabled={busy != null || !status.snapshot}
        onClick={() => void act('restore')}
      >
        {busy === 'restore' ? <Spinner /> : <Icon name="check" />} Reset demo
      </button>
      <p className="text-center text-sm text-muted">
        {status.snapshot
          ? `Snapshot from ${new Date(status.snapshot.saved_at).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}: ${status.snapshot.counts.invoices} invoices, ${status.snapshot.counts.products} products.`
          : 'No snapshot yet. Load the demo data, then save one below.'}
      </p>

      {result && (
        <p
          className={`card px-4 py-3 text-sm ${result.ok ? 'border-brand/30 bg-brand-soft text-brand-dark' : 'border-rust/30 bg-rust-soft text-rust'}`}
        >
          {result.text}
        </p>
      )}

      <section className="card divide-y divide-line">
        <Row
          label="Demo mode"
          value={
            status.demo_mode
              ? 'On: cached answers, no API calls'
              : 'Off: live Claude API'
          }
        />
        <Row label="Model" value={status.model} />
        <Row
          label="API key"
          value={status.has_api_key ? 'Set' : 'Missing'}
          warn={!status.has_api_key && !status.demo_mode}
        />
      </section>

      <div className="grid grid-cols-2 gap-2">
        <button
          className="btn-secondary"
          disabled={busy != null}
          onClick={() => void act('snapshot')}
        >
          {busy === 'snapshot' && <Spinner className="h-4 w-4" />} Save snapshot
        </button>
        <button
          className="btn-secondary text-rust"
          disabled={busy != null}
          onClick={() => void act('wipe')}
        >
          {busy === 'wipe' && <Spinner className="h-4 w-4" />} Delete everything
        </button>
      </div>
    </div>
  )
}

function Row({
  label,
  value,
  warn,
}: {
  label: string
  value: string
  warn?: boolean
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3 text-sm">
      <span className="text-muted">{label}</span>
      <span className={`font-medium ${warn ? 'text-rust' : ''}`}>{value}</span>
    </div>
  )
}
