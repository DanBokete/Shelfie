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
      const apiErr = toAIError(err)
      if (apiErr) throw apiErr
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

/** API and connection failures as an AIError; null for anything else. */
function toAIError(err: unknown): AIError | null {
  if (err instanceof AIError) return err
  if (
    err instanceof Anthropic.APIError &&
    err.status &&
    err.status < 500 &&
    err.status !== 429
  ) {
    return new AIError(`Claude API error ${err.status}: ${err.message}`, 'api')
  }
  if (
    err instanceof Anthropic.APIError ||
    err instanceof Anthropic.APIConnectionError
  ) {
    return new AIError(`Claude API unavailable: ${err.message}`, 'api')
  }
  return null
}

export interface WebSource {
  url: string
  title: string
  /** When the page text was retrieved. Fetches can return a cached copy weeks old. */
  retrieved_at: string | null
}

/** Server tool loops stop after 10 steps with pause_turn; resume this many times at most. */
const MAX_RESUMES = 4

/**
 * One research turn with live web search and page fetch, searched as if from Cork.
 * Returns Claude's written findings and every page the tools returned, so callers can
 * reject any link Claude did not actually see. Never cached: the point is fresh data.
 */
export async function searchWeb(opts: {
  /** Short name for logs, e.g. 'prices'. */
  name: string
  system: string
  prompt: string
  maxSearches?: number
  maxFetches?: number
  effort?: Effort
}): Promise<{ text: string; sources: Array<WebSource> }> {
  if (demoMode()) {
    throw new AIError(
      'Live price search needs the internet. Set DEMO_MODE=false.',
      'demo_cache_miss',
    )
  }
  const messages: Array<Anthropic.Beta.BetaMessageParam> = [
    { role: 'user', content: opts.prompt },
  ]
  const sources = new Map<string, WebSource>()
  const text: Array<string> = []
  const started = Date.now()

  for (let turn = 0; turn <= MAX_RESUMES; turn++) {
    let res: Anthropic.Beta.BetaMessage
    try {
      res = await getClient().beta.messages.create({
        model: model(),
        max_tokens: 16000,
        system: opts.system,
        messages,
        tools: [
          {
            type: 'web_search_20260209',
            name: 'web_search',
            // Searches run in code, several at a time, so a small limit is gone in one step.
            max_uses: opts.maxSearches ?? 12,
            // The API rejects country 'IE', so Ireland comes from the city and the prompt.
            user_location: {
              type: 'approximate',
              city: 'Cork',
              timezone: 'Europe/Dublin',
            },
          },
          {
            type: 'web_fetch_20260209',
            name: 'web_fetch',
            max_uses: opts.maxFetches ?? 12,
          },
        ],
        output_config: { effort: opts.effort ?? 'medium' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      })
    } catch (err) {
      throw (
        toAIError(err) ??
        new AIError(err instanceof Error ? err.message : String(err), 'api')
      )
    }

    for (const block of res.content) {
      if (block.type === 'text') text.push(block.text)
      // Errors come back as a result block with an error object, not as a thrown error.
      if (
        block.type === 'web_search_tool_result' &&
        Array.isArray(block.content)
      ) {
        for (const r of block.content) {
          if (!sources.has(r.url))
            sources.set(r.url, {
              url: r.url,
              title: r.title,
              retrieved_at: null,
            })
        }
      }
      if (
        block.type === 'web_fetch_tool_result' &&
        block.content.type === 'web_fetch_result'
      ) {
        const { url, retrieved_at, content } = block.content
        sources.set(url, {
          url,
          title: content.title ?? sources.get(url)?.title ?? url,
          retrieved_at,
        })
      }
    }
    console.info(
      `[claude:${opts.name}] ${res.model} turn ${turn + 1} ${Date.now() - started}ms in=${res.usage.input_tokens} out=${res.usage.output_tokens} stop=${res.stop_reason} sources=${sources.size}`,
    )
    if (res.stop_reason === 'refusal') {
      throw new AIError('Claude declined this request.', 'refusal')
    }
    if (res.stop_reason !== 'pause_turn') break
    // Send the paused turn back unchanged and the server carries on where it stopped.
    messages.push({ role: 'assistant', content: res.content })
  }

  return {
    text: text.join('\n').trim(),
    sources: [...sources.values()],
  }
}
