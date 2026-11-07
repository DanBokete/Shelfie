// Prepares files in the browser before upload: HEIC photos become JPEG, and big photos are
// scaled down (long edge 2400 px) so uploads stay small and fast on a phone connection.
const MAX_EDGE = 2400

export function isHeic(file: File): boolean {
  return /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)
}

export async function prepareUpload(
  file: File,
): Promise<{ blob: Blob; name: string }> {
  let blob: Blob = file
  let name = file.name
  if (isHeic(file)) {
    const { default: heic2any } = await import('heic2any')
    const out = await heic2any({
      blob: file,
      toType: 'image/jpeg',
      quality: 0.9,
    })
    blob = Array.isArray(out) ? out[0] : out
    name = name.replace(/\.(heic|heif)$/i, '.jpg')
  }
  if (!blob.type.startsWith('image/') || blob.type === 'image/gif')
    return { blob, name }
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  if (scale === 1 && blob.size < 3_000_000) {
    bitmap.close()
    return { blob, name }
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
  return { blob: jpeg, name: name.replace(/\.[a-z0-9]+$/i, '') + '.jpg' }
}
