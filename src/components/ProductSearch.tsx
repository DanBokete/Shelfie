import { useEffect, useState } from 'react'
import { Icon, Spinner } from './Icon'
import { findProducts } from '#/server/fns'

export interface ProductOption {
  id: string
  canonical_name: string
  base_unit: 'ml' | 'g' | 'each'
  category: string | null
}

export function ProductSearch({
  initial = '',
  onSelect,
  onCreate,
  autoFocus = true,
}: {
  initial?: string
  onSelect: (p: ProductOption) => void
  onCreate?: (name: string) => void
  autoFocus?: boolean
}) {
  const [q, setQ] = useState(initial)
  const [results, setResults] = useState<Array<ProductOption> | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let live = true
    setLoading(true)
    const t = setTimeout(() => {
      findProducts({ data: { q } })
        .then((r) => live && setResults(r))
        .finally(() => live && setLoading(false))
    }, 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q])

  return (
    <div className="space-y-2">
      <label className="relative block">
        <span className="sr-only">Search products</span>
        <Icon
          name="search"
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted"
        />
        <input
          className="input pl-9"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search products"
          autoFocus={autoFocus}
        />
        {loading && (
          <Spinner className="absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-muted" />
        )}
      </label>
      <ul className="max-h-64 divide-y divide-line overflow-auto rounded-xl border border-line bg-card">
        {results?.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2.5 text-left hover:bg-soft"
              onClick={() => onSelect(p)}
            >
              <span className="font-medium">{p.canonical_name}</span>
              <span className="text-xs text-muted">{p.category}</span>
            </button>
          </li>
        ))}
        {results?.length === 0 && (
          <li className="px-3 py-2.5 text-sm text-muted">
            No products match "{q}".
          </li>
        )}
        {onCreate && q.trim().length >= 2 && (
          <li>
            <button
              type="button"
              className="w-full px-3 py-2.5 text-left text-sm font-semibold text-brand hover:bg-soft"
              onClick={() => onCreate(q.trim())}
            >
              + New product "{q.trim()}"
            </button>
          </li>
        )}
      </ul>
    </div>
  )
}
