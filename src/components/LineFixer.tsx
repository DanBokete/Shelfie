// Inline fixes for one flagged price line: confirm it, pick another product, or correct the numbers.
import { useState } from 'react'
import { Spinner } from './Icon'
import { ProductSearch } from './ProductSearch'
import {
  changeMatch,
  confirmMatch,
  createProductForLine,
  editInvoiceLine,
} from '#/server/fns'

export interface FixableLine {
  id: string
  raw_description: string
  quantity: number | null
  pack_price: number
  pack_size: number | null
  pack_unit: string | null
  units_per_case: number | null
  review_reasons: Array<string>
  products: {
    id: string
    canonical_name: string
    base_unit: 'ml' | 'g' | 'each'
  } | null
}

type Mode = 'idle' | 'change' | 'edit'

export function LineFixer({
  line,
  onDone,
}: {
  line: FixableLine
  onDone: () => void
}) {
  const [mode, setMode] = useState<Mode>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setMode('idle')
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          className="btn-primary px-3 py-2"
          disabled={busy}
          onClick={() => run(() => confirmMatch({ data: { id: line.id } }))}
        >
          {busy && mode === 'idle' ? <Spinner className="h-4 w-4" /> : null}
          Confirm
        </button>
        <button
          className="btn-secondary px-3 py-2"
          disabled={busy}
          onClick={() => setMode(mode === 'change' ? 'idle' : 'change')}
        >
          Change
        </button>
        <button
          className="btn-secondary px-3 py-2"
          disabled={busy}
          onClick={() => setMode(mode === 'edit' ? 'idle' : 'edit')}
        >
          Edit numbers
        </button>
      </div>
      {mode === 'change' && (
        <ProductSearch
          onSelect={(p) =>
            run(() => changeMatch({ data: { id: line.id, product_id: p.id } }))
          }
          onCreate={(name) =>
            run(() =>
              createProductForLine({
                data: {
                  id: line.id,
                  canonical_name: name,
                  base_unit: guessUnit(line.pack_unit),
                  category: null,
                },
              }),
            )
          }
        />
      )}
      {mode === 'edit' && (
        <EditForm
          line={line}
          busy={busy}
          onSave={(f) =>
            run(() => editInvoiceLine({ data: { id: line.id, ...f } }))
          }
        />
      )}
      {error && <p className="text-sm text-rust">{error}</p>}
    </div>
  )
}

function guessUnit(u: string | null): 'ml' | 'g' | 'each' {
  if (u === 'ml' || u === 'l' || u === 'cl') return 'ml'
  if (u === 'g' || u === 'kg') return 'g'
  return 'each'
}

const UNITS = ['ml', 'cl', 'l', 'g', 'kg', 'each'] as const

function EditForm({
  line,
  busy,
  onSave,
}: {
  line: FixableLine
  busy: boolean
  onSave: (f: {
    pack_price: number
    quantity: number | null
    pack_size: number | null
    pack_unit: (typeof UNITS)[number] | null
    units_per_case: number | null
  }) => void
}) {
  const [price, setPrice] = useState(String(line.pack_price))
  const [qty, setQty] = useState(
    line.quantity == null ? '' : String(line.quantity),
  )
  const [size, setSize] = useState(
    line.pack_size == null ? '' : String(line.pack_size),
  )
  const [unit, setUnit] = useState(line.pack_unit ?? '')
  const [perCase, setPerCase] = useState(
    line.units_per_case == null ? '1' : String(line.units_per_case),
  )
  const num = (s: string) => (s.trim() === '' ? null : Number(s))
  const valid =
    Number(price) >= 0 &&
    price.trim() !== '' &&
    [qty, size, perCase].every(
      (s) => s.trim() === '' || Number.isFinite(Number(s)),
    )

  return (
    <form
      className="grid grid-cols-2 gap-3 sm:grid-cols-5"
      onSubmit={(e) => {
        e.preventDefault()
        onSave({
          pack_price: Number(price),
          quantity: num(qty),
          pack_size: num(size),
          pack_unit: (UNITS as ReadonlyArray<string>).includes(unit)
            ? (unit as (typeof UNITS)[number])
            : null,
          units_per_case:
            num(perCase) == null
              ? null
              : Math.max(1, Math.round(num(perCase)!)),
        })
      }}
    >
      <Field label="Qty">
        <input
          className="input"
          inputMode="decimal"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
        />
      </Field>
      <Field label="Pack price €">
        <input
          className="input"
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
      </Field>
      <Field label="Units per case">
        <input
          className="input"
          inputMode="numeric"
          value={perCase}
          onChange={(e) => setPerCase(e.target.value)}
        />
      </Field>
      <Field label="Size">
        <input
          className="input"
          inputMode="decimal"
          value={size}
          onChange={(e) => setSize(e.target.value)}
        />
      </Field>
      <Field label="Unit">
        <select
          className="input"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
        >
          <option value="">unknown</option>
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </Field>
      <div className="col-span-2 sm:col-span-5">
        <button className="btn-primary" disabled={busy || !valid}>
          {busy && <Spinner className="h-4 w-4" />}
          Save
        </button>
      </div>
    </form>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="block space-y-1">
      <span className="label">{label}</span>
      {children}
    </label>
  )
}
