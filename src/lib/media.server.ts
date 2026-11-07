// Turns an uploaded file into a Claude content block. Images are resized so the long edge is
// at most 2000 px and re-encoded as JPEG.
import sharp from 'sharp'
import type Anthropic from '@anthropic-ai/sdk'

export const ACCEPTED_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const

export function mediaTypeFor(fileName: string, declared: string): string {
  const lower = fileName.toLowerCase()
  if (declared && declared !== 'application/octet-stream') return declared
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  return declared
}

export async function toContentBlock(
  bytes: Uint8Array,
  mediaType: string,
): Promise<Anthropic.Beta.BetaContentBlockParam> {
  if (mediaType === 'application/pdf') {
    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: Buffer.from(bytes).toString('base64'),
      },
    }
  }
  if (!mediaType.startsWith('image/'))
    throw new Error(`Unsupported file type: ${mediaType}`)
  const jpeg = await sharp(bytes)
    .rotate() // honour EXIF orientation from phone cameras
    .resize({
      width: 2000,
      height: 2000,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer()
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/jpeg',
      data: jpeg.toString('base64'),
    },
  }
}
