// Encrypting secrets at rest (the Google refresh token, the sign-in cookie) with
// AES-256-GCM. The key is TOKEN_ENCRYPTION_KEY in .env: 32 random bytes, base64.
// Make one with `openssl rand -base64 32`.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 'v1'
const IV_BYTES = 12
const TAG_BYTES = 16

/** A setup problem the owner fixes in .env. */
export class TokenKeyError extends Error {}

/** The key from TOKEN_ENCRYPTION_KEY, or a TokenKeyError saying what is wrong with it. */
export function encryptionKey(
  raw: string | undefined = process.env.TOKEN_ENCRYPTION_KEY,
): Buffer {
  if (!raw)
    throw new TokenKeyError(
      'TOKEN_ENCRYPTION_KEY is not set. Make one with `openssl rand -base64 32`, add it to .env and restart.',
    )
  const key = Buffer.from(raw.trim(), 'base64')
  if (key.length !== 32)
    throw new TokenKeyError(
      'TOKEN_ENCRYPTION_KEY must be 32 bytes in base64. Make one with `openssl rand -base64 32`.',
    )
  return key
}

/** "v1.<iv>.<tag>.<ciphertext>", each part base64url. */
export function encrypt(plain: string, key: Buffer = encryptionKey()): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [VERSION, iv, cipher.getAuthTag(), data]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.')
}

/** The plain text, or throws when the value was changed or the key is different. */
export function decrypt(sealed: string, key: Buffer = encryptionKey()): string {
  const parts = sealed.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION)
    throw new Error('Not an encrypted value')
  const [, iv, tag, data] = parts
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(iv, 'base64url'),
    { authTagLength: TAG_BYTES },
  )
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}
