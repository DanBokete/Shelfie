import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Html5Qrcode } from 'html5-qrcode'
import { Icon, Spinner } from '#/components/Icon'
import { ProductSearch } from '#/components/ProductSearch'
import { postFile } from '#/lib/api'
import { prepareUpload } from '#/lib/client-files'
import { lookupBarcode, saveBarcode } from '#/server/fns'

export const Route = createFileRoute('/scan')({
  component: ScanPage,
  head: () => ({ meta: [{ title: 'Scan - Shelfie' }] }),
})

const READER_ID = 'shelfie-reader'
const PHOTO_FALLBACK_AFTER_MS = 4000

type Phase =
  | { kind: 'camera' }
  | { kind: 'looking'; code: string }
  | { kind: 'unknown'; code: string }
  | { kind: 'identifying'; code: string | null }
  | {
      kind: 'confirm'
      code: string | null
      product: { id: string; canonical_name: string }
      seen: string
    }
  | { kind: 'search'; code: string | null; note?: string }

interface IdentifyResult {
  product: { id: string; canonical_name: string } | null
  confidence: number
  what_you_see: string
}

function ScanPage() {
  const navigate = useNavigate()
  const scanner = useRef<Html5Qrcode | null>(null)
  const handled = useRef(false)
  const photoInput = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'camera' })
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [cameraOn, setCameraOn] = useState(false)
  const [showPhoto, setShowPhoto] = useState(false)
  const [torch, setTorch] = useState<{ supported: boolean; on: boolean }>({
    supported: false,
    on: false,
  })
  const [manual, setManual] = useState('')
  const [error, setError] = useState<string | null>(null)

  const stopCamera = useCallback(async () => {
    const s = scanner.current
    if (s?.isScanning) await s.stop().catch(() => undefined)
    setCameraOn(false)
  }, [])

  const goTo = useCallback(
    (productId: string) =>
      navigate({ to: '/item/$productId', params: { productId } }),
    [navigate],
  )

  const onCode = useCallback(
    async (raw: string) => {
      const code = raw.trim()
      if (handled.current) return
      handled.current = true
      // Not every browser has vibrate (iOS Safari doesn't), whatever the DOM types say.
      if ('vibrate' in navigator) navigator.vibrate(60)
      void stopCamera()
      setPhase({ kind: 'looking', code })
      try {
        const p = await lookupBarcode({ data: { code } })
        if (p) return void goTo(p.id)
        setPhase({ kind: 'unknown', code })
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Lookup failed')
        setPhase({ kind: 'unknown', code })
      }
    },
    [goTo, stopCamera],
  )

  // Camera lifecycle
  useEffect(() => {
    if (phase.kind !== 'camera') return
    const run = { cancelled: false }
    // A function, so the check is re-read after every await (the cleanup sets it at any time).
    const cancelled = () => run.cancelled
    handled.current = false
    setShowPhoto(false)
    const timer = setTimeout(() => setShowPhoto(true), PHOTO_FALLBACK_AFTER_MS)
    void (async () => {
      try {
        const { Html5Qrcode, Html5QrcodeSupportedFormats } =
          await import('html5-qrcode')
        if (cancelled()) return
        const s = new Html5Qrcode(READER_ID, {
          verbose: false,
          formatsToSupport: [
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.UPC_A,
          ],
          useBarCodeDetectorIfSupported: true,
        })
        scanner.current = s
        await s.start(
          { facingMode: 'environment' },
          {
            fps: 12,
            qrbox: (w, h) => ({
              width: Math.min(320, Math.floor(w * 0.85)),
              height: Math.min(170, Math.floor(h * 0.5)),
            }),
            aspectRatio: 4 / 3,
          },
          (text) => void onCode(text),
          () => undefined,
        )
        if (cancelled()) return void s.stop().catch(() => undefined)
        setCameraOn(true)
        setCameraError(null)
        const caps =
          s.getRunningTrackCapabilities() as MediaTrackCapabilities & {
            torch?: boolean
          }
        setTorch({ supported: Boolean(caps.torch), on: false })
      } catch (e) {
        if (cancelled()) return
        setShowPhoto(true)
        setCameraError(
          window.isSecureContext
            ? 'Camera unavailable. Allow camera access, or type the barcode below.'
            : 'The camera needs a secure (https) connection. Type the barcode below instead.',
        )
        console.warn('camera', e)
      }
    })()
    return () => {
      run.cancelled = true
      clearTimeout(timer)
      void stopCamera()
    }
  }, [phase.kind, onCode, stopCamera])

  async function toggleTorch() {
    const next = !torch.on
    await scanner.current
      ?.applyVideoConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      })
      .catch(() => undefined)
    setTorch((t) => ({ ...t, on: next }))
  }

  /** Grabs the current camera frame; falls back to the phone's camera app if there is no live video. */
  async function takePhoto() {
    const video = document.querySelector<HTMLVideoElement>(
      `#${READER_ID} video`,
    )
    if (!video || !video.videoWidth) return photoInput.current?.click()
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')!.drawImage(video, 0, 0)
    const blob = await new Promise<Blob | null>((r) =>
      canvas.toBlob(r, 'image/jpeg', 0.9),
    )
    if (blob) await identify(blob, 'frame.jpg')
  }

  async function identify(blob: Blob, name: string) {
    const code = 'code' in phase ? phase.code : null
    handled.current = true
    void stopCamera()
    setError(null)
    setPhase({ kind: 'identifying', code })
    try {
      const r = await postFile<IdentifyResult>('/api/scan/identify', blob, name)
      if (r.product)
        setPhase({
          kind: 'confirm',
          code,
          product: r.product,
          seen: r.what_you_see,
        })
      else
        setPhase({
          kind: 'search',
          code,
          note: `We saw ${r.what_you_see.toLowerCase()}, but it's not in your products.`,
        })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not identify the photo')
      setPhase({ kind: 'search', code })
    }
  }

  async function choose(productId: string, code: string | null) {
    try {
      if (code && /^\d{8,14}$/.test(code))
        await saveBarcode({ data: { product_id: productId, barcode: code } })
    } catch (e) {
      console.warn('saving barcode failed', e)
    }
    void goTo(productId)
  }

  const restart = () => {
    setError(null)
    setPhase({ kind: 'camera' })
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Scan an item</h1>
        <p className="mt-1 text-muted">Point the camera at a barcode.</p>
      </div>

      {phase.kind === 'camera' && (
        <>
          <div className="relative overflow-hidden rounded-3xl bg-ink shadow-lg">
            <div
              id={READER_ID}
              className="aspect-[4/3] w-full [&_video]:h-full [&_video]:w-full [&_video]:object-cover"
            />
            {!cameraOn && !cameraError && (
              <div className="absolute inset-0 grid place-items-center text-white/80">
                <Spinner className="h-8 w-8" />
              </div>
            )}
            {cameraError && (
              <div className="absolute inset-0 grid place-items-center px-8 text-center text-sm text-white/90">
                {cameraError}
              </div>
            )}
            {torch.supported && (
              <button
                onClick={() => void toggleTorch()}
                className={`absolute top-3 right-3 grid h-11 w-11 place-items-center rounded-full ${torch.on ? 'bg-white text-ink' : 'bg-black/50 text-white'}`}
                aria-label={torch.on ? 'Turn torch off' : 'Turn torch on'}
              >
                <Icon name="flash" />
              </button>
            )}
          </div>
          {showPhoto && (
            <button
              className="btn-secondary w-full py-3"
              onClick={() => void takePhoto()}
            >
              <Icon name="camera" className="h-4 w-4" /> Take photo instead
            </button>
          )}
          <input
            ref={photoInput}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (!f) return
              const { blob, name } = await prepareUpload(f)
              await identify(blob, name)
            }}
          />
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (manual.trim().length >= 6) void onCode(manual)
            }}
          >
            <input
              className="input"
              inputMode="numeric"
              placeholder="Or type the barcode"
              value={manual}
              onChange={(e) => setManual(e.target.value.replace(/\D/g, ''))}
            />
            <button className="btn-secondary" disabled={manual.length < 6}>
              Look up
            </button>
          </form>
        </>
      )}

      {(phase.kind === 'looking' || phase.kind === 'identifying') && (
        <div className="card flex items-center gap-3 px-5 py-8">
          <Spinner className="h-6 w-6 text-brand" />
          <p className="font-medium">
            {phase.kind === 'looking'
              ? `Looking up ${phase.code}...`
              : 'Working out what this is...'}
          </p>
        </div>
      )}

      {phase.kind === 'unknown' && (
        <div className="card space-y-4 px-5 py-5">
          <p>
            We haven't seen barcode <b className="font-mono">{phase.code}</b>{' '}
            before. Take a photo of the product, or pick it below. Next time
            it'll be instant.
          </p>
          <div className="flex gap-2">
            <button
              className="btn-primary flex-1"
              onClick={() => photoInput.current?.click()}
            >
              <Icon name="camera" className="h-4 w-4" /> Take photo
            </button>
            <button className="btn-secondary" onClick={restart}>
              Scan again
            </button>
          </div>
          <ProductSearch
            autoFocus={false}
            onSelect={(p) => void choose(p.id, phase.code)}
          />
          <input
            ref={photoInput}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (!f) return
              const { blob, name } = await prepareUpload(f)
              await identify(blob, name)
            }}
          />
        </div>
      )}

      {phase.kind === 'confirm' && (
        <div className="card space-y-4 px-5 py-6 text-center">
          <p className="text-sm text-muted">
            We see {phase.seen.toLowerCase()}
          </p>
          <p className="text-xl font-bold">
            Is this {phase.product.canonical_name}?
          </p>
          <div className="flex gap-2">
            <button
              className="btn-primary flex-1 py-3"
              onClick={() => void choose(phase.product.id, phase.code)}
            >
              Yes
            </button>
            <button
              className="btn-secondary flex-1 py-3"
              onClick={() => setPhase({ kind: 'search', code: phase.code })}
            >
              No
            </button>
          </div>
        </div>
      )}

      {phase.kind === 'search' && (
        <div className="card space-y-3 px-5 py-5">
          <p className="font-semibold">Which product is it?</p>
          {phase.note && <p className="text-sm text-muted">{phase.note}</p>}
          <ProductSearch onSelect={(p) => void choose(p.id, phase.code)} />
          <button className="btn-ghost w-full" onClick={restart}>
            Scan again
          </button>
        </div>
      )}

      {error && <p className="text-sm text-rust">{error}</p>}
    </div>
  )
}
