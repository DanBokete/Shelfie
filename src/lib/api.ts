// Browser-side calls to the /api server routes.
export async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return read<T>(res)
}

export async function postFile<T>(
  url: string,
  file: Blob,
  name: string,
): Promise<T> {
  const form = new FormData()
  form.append('file', file, name)
  const res = await fetch(url, { method: 'POST', body: form })
  return read<T>(res)
}

async function read<T>(res: Response): Promise<T> {
  const text = await res.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(
      res.ok
        ? 'Unexpected response from the server'
        : `Server error ${res.status}`,
    )
  }
  if (!res.ok)
    throw new Error(
      (data as { error?: string }).error ?? `Server error ${res.status}`,
    )
  return data as T
}

/** Runs tasks with at most `size` in flight. */
export async function pool<T>(
  items: Array<T>,
  size: number,
  fn: (x: T, i: number) => Promise<void>,
): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        await fn(items[i], i)
      }
    }),
  )
}
