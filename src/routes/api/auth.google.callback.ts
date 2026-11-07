import { createFileRoute } from '@tanstack/react-router'
import { ConnectError, finishSignIn } from '#/lib/google-auth.server'
import {
  SIGN_IN_COOKIE,
  checkCallback,
  readCookie,
  redirectUriFor,
  signInCookie,
} from '#/lib/google-oauth.server'

// GET: Google sends the owner back here. Checks the state against the cookie, exchanges
// the code (with the PKCE verifier), stores the connection, and returns to Settings with
// ?gmail=<outcome> for the page to explain.
export const Route = createFileRoute('/api/auth/google/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const redirectUri = redirectUriFor(request)
        const back = (outcome: string) =>
          new Response(null, {
            status: 302,
            headers: {
              Location: `/settings?gmail=${outcome}`,
              // The sign-in is used once: clear it whatever happened.
              'Set-Cookie': signInCookie(
                '',
                redirectUri.startsWith('https:'),
                0,
              ),
              'Cache-Control': 'no-store',
            },
          })

        const check = checkCallback({
          params: new URL(request.url).searchParams,
          cookie: readCookie(request.headers.get('cookie'), SIGN_IN_COOKIE),
        })
        if (!check.ok) return back(check.problem)
        try {
          await finishSignIn({
            code: check.code,
            verifier: check.verifier,
            redirectUri,
          })
          return back('connected')
        } catch (err) {
          console.error('[gmail] connecting failed', err)
          return back(err instanceof ConnectError ? err.code : 'failed')
        }
      },
    },
  },
})
