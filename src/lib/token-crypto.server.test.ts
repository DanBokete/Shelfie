import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  TokenKeyError,
  decrypt,
  encrypt,
  encryptionKey,
} from './token-crypto.server'

const key = randomBytes(32)

describe('token encryption', () => {
  it('round-trips, with a fresh IV each time', () => {
    const token = '1//0gRefreshTokenFromGoogle-abc_123'
    const a = encrypt(token, key)
    const b = encrypt(token, key)
    expect(a).not.toBe(b)
    expect(a).not.toContain(token)
    expect(decrypt(a, key)).toBe(token)
    expect(decrypt(b, key)).toBe(token)
  })

  it('refuses a changed value or a different key', () => {
    const sealed = encrypt('secret', key)
    const parts = sealed.split('.')
    const data = Buffer.from(parts[3], 'base64url')
    data[0] ^= 1
    parts[3] = data.toString('base64url')
    expect(() => decrypt(parts.join('.'), key)).toThrow()
    expect(() => decrypt(sealed, randomBytes(32))).toThrow()
    expect(() => decrypt('not-encrypted', key)).toThrow()
  })

  it('needs a 32-byte base64 key', () => {
    expect(() => encryptionKey('')).toThrow(TokenKeyError)
    expect(() => encryptionKey(randomBytes(16).toString('base64'))).toThrow(
      /32 bytes/,
    )
    expect(encryptionKey(key.toString('base64'))).toEqual(key)
  })
})
