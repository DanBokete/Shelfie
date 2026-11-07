// One wrapper for every Claude call. Server only.
// - Structured outputs constrain the response to the zod schema's JSON shape.
// - The zod schema validates again (ranges, formats); invalid output retries once, then throws.
// - Every successful response is written to data/cache; with DEMO_MODE=true the cache is
//   served instead of calling the API, so the demo runs without internet.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import type { z } from 'zod'

export type Effort = 'low' | 'medium' | 'high'

export class AIError extends Error {
  constructor(
    message: string,
    readonly kind:
      'invalid_output' | 'refusal' | 'demo_cache_miss' | 'config' | 'api',
  ) {
    super(message)
  }
}

let client: Anthropic | null = null
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AIError(
      'ANTHROPIC_API_KEY is not set. Add it to .env, or set DEMO_MODE=true.',
      'config',
    )
  }
  // Pin the base URL so an ANTHROPIC_BASE_URL inherited from a developer tool's shell is ignored.
  client ??= new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL:
      process.env.SHELFIE_ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    timeout: 120_000,
    maxRetries: 2,
  })
  return client
}

export function model(): string {
  return process.env.SHELFIE_MODEL || 'claude-sonnet-5-5'
}

export function demoMode(): boolean {
  return process.env.DEMO_MODE === 'true'
}

const CACHE_DIR = path.join(process.cwd(), 'data', 'cache')

function cacheKey(name: string, system: string, content: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify({ name, system, content }))
    .digest('hex')
    .slice(0, 32)
}

async function readCache<T>(
  name: string,
  key: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const raw = JSON.parse(
      await readFile(path.join(CACHE_DIR, `${name}-${key}.json`), 'utf8'),
    )
    const parsed = schema.safeParse(raw.output)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function writeCache(
  name: string,
  key: string,
  output: unknown,
): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(
      path.join(CACHE_DIR, `${name}-${key}.json`),
      JSON.stringify(
        { name, model: model(), saved_at: new Date().toISOString(), output },
        null,
        2,
      ),
    )
  } catch {
    // Read-only filesystem (e.g. serverless). The cache is a demo aid, never required.
  }
}

export async function askJSON<T>(opts: {
  /** Short name for logs and cache files, e.g. 'extract'. */
  name: string
  system: string
  content: Anthropic.Beta.BetaContentBlockParam[] | string
  schema: z.ZodType<T>
  maxTokens?: number
  effort?: Effort
}): Promise<T> {
  const key = cacheKey(opts.name, opts.system, opts.content)
  const cached = await readCache(opts.name, key, opts.schema)
  if (demoMode()) {
    if (cached) return cached
    throw new AIError(
      `Demo mode is on and there is no cached answer for this ${opts.name} request.`,
      'demo_cache_miss',
    )
  }

  const userContent: Anthropic.Beta.BetaContentBlockParam[] =
    typeof opts.content === 'string'
      ? [{ type: 'text', text: opts.content }]
      : [...opts.content]

  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = lastError
      ? [
          ...userContent,
          {
            type: 'text' as const,
            text: `Your previous answer was rejected: ${lastError}\nReturn a corrected answer.`,
          },
        ]
      : userContent
    const started = Date.now()
    let res
    try {
      res = await getClient().beta.messages.parse({
        model: model(),
        max_tokens: opts.maxTokens ?? 16000,
        system: opts.system,
        messages: [{ role: 'user', content }],
        output_config: {
          effort: opts.effort ?? 'medium',
          format: betaZodOutputFormat(opts.schema),
        },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      })
    } catch (err) {
      if (err instanceof AIError) throw err
      if (
        err instanceof Anthropic.APIError &&
        err.status &&
        err.status < 500 &&
        err.status !== 429
      ) {
        throw new AIError(
          `Claude API error ${err.status}: ${err.message}`,
          'api',
        )
      }
      if (
        err instanceof Anthropic.APIError ||
        err instanceof Anthropic.APIConnectionError
      ) {
        throw new AIError(`Claude API unavailable: ${err.message}`, 'api')
      }
      // The SDK throws when the output fails the zod schema: retry once with the error.
      lastError = err instanceof Error ? err.message : String(err)
      console.warn(
        `[claude:${opts.name}] invalid output (attempt ${attempt + 1}): ${lastError}`,
      )
      continue
    }
    console.info(
      `[claude:${opts.name}] ${res.model} ${Date.now() - started}ms in=${res.usage.input_tokens} out=${res.usage.output_tokens} stop=${res.stop_reason}`,
    )
    if (res.stop_reason === 'refusal') {
      throw new AIError('Claude declined this request.', 'refusal')
    }
    if (res.stop_reason === 'max_tokens') {
      lastError = 'the answer was cut off. Be more concise.'
      continue
    }
    const out = opts.schema.safeParse(res.parsed_output)
    if (out.success) {
      await writeCache(opts.name, key, out.data)
      return out.data
    }
    lastError = out.error.message
    console.warn(
      `[claude:${opts.name}] invalid output (attempt ${attempt + 1}): ${lastError}`,
    )
  }
  throw new AIError(`Invalid AI output: ${lastError}`, 'invalid_output')
}
