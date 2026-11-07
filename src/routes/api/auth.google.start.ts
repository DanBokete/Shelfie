import { createFileRoute } from '@tanstack/react-router'
import { googleSetupProblem, startSignIn } from '#/lib/google-auth.server'
import { redirectUriFor, signInCookie } from '#/lib/google-oauth.server'

// GET: "Connect Gmail" in Settings. Sends the owner to Google's consent screen, with a
// random state and a PKCE verifier kept in an encrypted, httpOnly cookie for the callback.
export const Route = createFileRoute('/api/auth/google/start')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (googleSetupProblem())
          return Response.redirect(
            new URL('/settings?gmail=setup', request.url),
            302,
          )
        const redirectUri = redirectUriFor(request)
        const { url, cookie } = await startSignIn(redirectUri)
        return new Response(null, {
          status: 302,
          headers: {
            Location: url,
            'Set-Cookie': signInCookie(
              cookie,
              redirectUri.startsWith('https:'),
            ),
            'Cache-Control': 'no-store',
          },
        })
      },
    },
  },
})
