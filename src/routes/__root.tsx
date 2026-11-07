import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
  useRouter,
} from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '#/components/Icon'
import type { IconName } from '#/components/Icon'
import { postJSON } from '#/lib/api'
import { getBusiness } from '#/server/fns'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  // The business name and town from Settings, shown in the header and on the home page.
  loader: () => getBusiness(),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      { name: 'theme-color', content: '#f7f1e3' },
      { title: 'Shelfie - am I overpaying?' },
      {
        name: 'description',
        content:
          'See what you are overpaying your suppliers for, and fix it in one tap.',
      },
    ],
    links: [
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      {
        rel: 'preconnect',
        href: 'https://fonts.gstatic.com',
        crossOrigin: 'anonymous',
      },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap',
      },
      { rel: 'stylesheet', href: appCss },
      {
        rel: 'icon',
        href: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%230e1116'/><rect x='9' y='20' width='14' height='4' rx='1' fill='%23ffe135'/></svg>",
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
  to: '/' | '/invoices' | '/scan' | '/audit' | '/prices'
  label: string
  icon: IconName
}> = [
  { to: '/', label: 'Home', icon: 'home' },
  { to: '/audit', label: 'Savings', icon: 'list' },
  { to: '/prices', label: 'Live prices', icon: 'search' },
  { to: '/invoices', label: 'Invoices', icon: 'invoice' },
  { to: '/scan', label: 'Scan', icon: 'scan' },
]

function Logo() {
  return (
    <span
      aria-hidden="true"
      className="flex h-7 w-7 items-end justify-center rounded-md bg-ink pb-1.5"
    >
      <span className="h-1 w-3.5 rounded-[1px] bg-tag" />
    </span>
  )
}

/** How often the open app checks Gmail for supplier replies. */
const REPLY_CHECK_MS = 2 * 60_000

/**
 * While the app is open and visible, checks Gmail for replies to sent requests, and
 * refreshes the page when one was read so new prices show. The server skips a check made
 * within a minute of the last one, so several open tabs do not multiply the work.
 */
function useReplyChecks() {
  const router = useRouter()
  useEffect(() => {
    const check = () => {
      if (document.hidden) return
      void postJSON<{ read: number }>('/api/email/replies', {})
        .then((r) => {
          if (r.read > 0) void router.invalidate()
        })
        .catch(() => undefined)
    }
    check()
    const timer = setInterval(check, REPLY_CHECK_MS)
    document.addEventListener('visibilitychange', check)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [router])
}

function RootComponent() {
  const business = Route.useLoaderData()
  useReplyChecks()
  return (
    <div className="min-h-dvh pb-24 md:flex md:pb-0">
      {/* Desktop: grey sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-4 border-r border-line bg-side px-2.5 py-3.5 md:flex">
        <Link to="/" className="flex items-center gap-2.5 px-2 py-1">
          <Logo />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="text-sm font-semibold">Shelfie</span>
            <span className="truncate text-xs text-muted">{business.name}</span>
          </span>
        </Link>
        <nav aria-label="Main" className="flex flex-col gap-px">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm text-ink hover:bg-soft"
              activeProps={{ className: 'bg-line font-semibold' }}
              activeOptions={{ exact: n.to === '/' }}
            >
              <Icon name={n.icon} className="h-4 w-4" />
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2">
          <Link
            to="/settings"
            className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm text-ink hover:bg-soft"
            activeProps={{ className: 'bg-line font-semibold' }}
          >
            <Icon name="settings" className="h-4 w-4" />
            Settings
          </Link>
          <Link
            to="/scan"
            className="flex h-10 items-center gap-2.5 rounded-lg border border-line bg-card px-2.5 text-sm hover:bg-soft"
          >
            <Icon name="scan" className="h-4 w-4" />
            Scan with your phone
          </Link>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {/* Phone: slim top bar */}
        <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur md:hidden">
          <div className="flex h-14 items-center justify-between px-4">
            <Link
              to="/"
              className="flex items-center gap-2 text-base font-semibold"
            >
              <Logo />
              Shelfie
            </Link>
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate text-sm text-muted">
                {business.name}
              </span>
              <Link
                to="/settings"
                aria-label="Settings"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-soft hover:text-ink"
              >
                <Icon name="settings" className="h-5 w-5" />
              </Link>
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-5 md:px-8 md:py-8">
          <Outlet />
        </main>
      </div>

      {/* Phone: bottom tabs */}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        <div className="mx-auto grid max-w-md grid-cols-5">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className="flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium text-muted"
              activeProps={{ className: '!text-ink' }}
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
