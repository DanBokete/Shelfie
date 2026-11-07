// Prepares files in the browser before upload: HEIC photos become JPEG, and big photos are
// scaled down (long edge 2400 px) so uploads stay small and fast on a phone connection.
const MAX_EDGE = 2400

export function isHeic(file: File): boolean {
  return /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)
}

export async function prepareUpload(
  file: File,
): Promise<{ blob: Blob; name: string }> {
  const heic = isHeic(file)
  if (!heic && (!file.type.startsWith('image/') || file.type === 'image/gif'))
    return { blob: file, name: file.name }

  // Most browsers cannot decode HEIC themselves, so it is decoded with libheif (WASM).
  const bitmap = heic ? await decodeHeic(file) : await createImageBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  if (!heic && scale === 1 && file.size < 3_000_000) {
    bitmap.close()
    return { blob: file, name: file.name }
  }
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const jpeg = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) =>
        b ? resolve(b) : reject(new Error('Could not process the photo')),
      'image/jpeg',
      0.85,
    ),
  )
  return { blob: jpeg, name: file.name.replace(/\.[a-z0-9]+$/i, '') + '.jpg' }
}

async function decodeHeic(file: File): Promise<ImageBitmap> {
  const { heicTo } = await import('heic-to')
  try {
    return await heicTo({ blob: file, type: 'bitmap' })
  } catch (e) {
    console.error('HEIC decode failed', e)
    throw new Error(
      "Couldn't read this HEIC photo. Try exporting it as JPEG and uploading that.",
    )
  }
}
