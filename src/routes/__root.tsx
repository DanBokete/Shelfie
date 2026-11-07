import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
  useRouter,
} from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Icon } from '#/components/Icon'
import type { IconName } from '#/components/Icon'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      { name: 'theme-color', content: '#faf6f0' },
      { title: 'Shelfie - am I overpaying?' },
      {
        name: 'description',
        content:
          'See what you are overpaying your suppliers for, and fix it in one tap.',
      },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      {
        rel: 'icon',
        href: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%231f6f4a'/><path d='M8 22h16M10 22V12h4v10M17 22V9h5v13' stroke='white' stroke-width='2.4' fill='none' stroke-linejoin='round'/></svg>",
      },
    ],
  }),
  component: RootComponent,
  shellComponent: RootDocument,
  errorComponent: RootError,
})

function RootError({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <div className="card space-y-4 px-6 py-8 text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-rust-soft text-rust">
          <Icon name="alert" className="h-6 w-6" />
        </span>
        <h1 className="text-xl font-bold">Something went wrong</h1>
        <p className="text-sm break-words text-muted">
          {error instanceof Error ? error.message : String(error)}
        </p>
        <div className="flex justify-center gap-2">
          <button
            className="btn-primary"
            onClick={() => {
              reset()
              void router.invalidate()
            }}
          >
            Try again
          </button>
          <Link to="/" className="btn-secondary">
            Home
          </Link>
        </div>
      </div>
    </div>
  )
}

const NAV: Array<{
  to: '/' | '/invoices' | '/scan' | '/audit'
  label: string
  icon: IconName
}> = [
  { to: '/', label: 'Home', icon: 'home' },
  { to: '/invoices', label: 'Invoices', icon: 'invoice' },
  { to: '/scan', label: 'Scan', icon: 'scan' },
  { to: '/audit', label: 'Stock list', icon: 'list' },
]

function RootComponent() {
  return (
    <div className="min-h-dvh pb-24 md:pb-0">
      <header className="sticky top-0 z-20 border-b border-line/80 bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <Link
            to="/"
            className="flex items-center gap-2 text-lg font-bold tracking-tight"
          >
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-white">
              <Icon name="logo" className="h-5 w-5" />
            </span>
            Shelfie
          </Link>
          <nav className="hidden gap-1 md:flex">
            {NAV.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                className="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-soft hover:text-ink"
                activeProps={{ className: 'bg-soft !text-ink' }}
                activeOptions={{ exact: n.to === '/' }}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <span className="text-sm text-muted md:hidden">The Corner Café</span>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-5 md:py-8">
        <Outlet />
      </main>
      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        <div className="mx-auto grid max-w-md grid-cols-4">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className="flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium text-muted"
              activeProps={{ className: '!text-brand' }}
              activeOptions={{ exact: n.to === '/' }}
            >
              <Icon name={n.icon} className="h-6 w-6" />
              {n.label}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IE">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
