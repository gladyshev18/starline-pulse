import { normalizeOrderNumber, parseActText, type ParsedAct } from '../shared/act-parser'

// Photographed on a table, an act arrives at any of four right angles, and
// Tesseract does not rotate for you: the wrong one drops confidence from 85 to
// 43 and yields nothing at all. So every orientation is tried and the reads are
// pooled — the label anchors say which attempts understood the page, and a field
// is taken from the attempts that did.
const ROTATIONS = [0, 90, 180, 270] as const

// Below this an attempt did not find the form, only noise shaped like text.
const MIN_ANCHORS = 4

export interface ActOcrField<T> {
  value: T | null
  // How many independent attempts produced this exact value. One is a reading;
  // several agreeing is a measurement.
  votes: number
  disputed: boolean
}

export interface ActOcrResult {
  attempts: number
  bestRotation: number | null
  confidence: number
  orderNumber: ActOcrField<string>
  performedAt: ActOcrField<Date>
  mileage: ActOcrField<number>
  totalAmount: ActOcrField<number>
  isServiceAct: boolean
  mentionsOil: boolean
  text: string
}

const empty = <T>(): ActOcrField<T> => ({ value: null, votes: 0, disputed: false })

function tally<T>(values: T[], key: (value: T) => string): ActOcrField<T> {
  if (!values.length) return empty<T>()
  const counts = new Map<string, { value: T, votes: number }>()
  for (const value of values) {
    const id = key(value)
    const current = counts.get(id)
    if (current) current.votes++
    else counts.set(id, { value, votes: 1 })
  }
  const ranked = [...counts.values()].sort((a, b) => b.votes - a.votes)
  const winner = ranked[0]!
  return {
    value: winner.value,
    votes: winner.votes,
    // A tie means two readings are equally supported and neither can be trusted.
    disputed: ranked.length > 1 && ranked[1]!.votes >= winner.votes
  }
}

// Kept out of the module scope so a worker is never shared between recognitions:
// Tesseract keeps the page segmentation mode on the worker, and a mode left over
// from a previous call silently turns a good read into gibberish.
// The language models are fetched once and kept. They must land somewhere
// writable, and in the container only the data volume is — the image root is
// mounted read-only, so the default of caching beside the code would fail.
export function getTesseractCacheDir() {
  return process.env.TESSERACT_CACHE_DIR || 'data/tesseract'
}

async function recognize(png: string, psm: string) {
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('rus+eng', undefined, { cachePath: getTesseractCacheDir() })
  try {
    await worker.setParameters({ tessedit_pageseg_mode: psm as never })
    const { data } = await worker.recognize(png)
    return { text: data.text, confidence: data.confidence }
  } finally {
    await worker.terminate()
  }
}

async function prepare(data: Buffer, rotation: number, target: string) {
  const { Jimp } = await import('jimp')
  const image = await Jimp.read(data)
  if (rotation) image.rotate(rotation)
  // Tesseract wants roughly 300 dpi; a phone frame of the whole sheet lands well
  // below that, and doubling is what brings the table digits into its range.
  image.scale(2).greyscale().contrast(0.3)
  await image.write(target as `${string}.png`)
}

export async function recognizeAct(data: Buffer, workDir: string): Promise<ActOcrResult> {
  const { join } = await import('node:path')
  const { mkdir, rm } = await import('node:fs/promises')
  await mkdir(workDir, { recursive: true })

  const reads: Array<{ rotation: number, parsed: ParsedAct, confidence: number }> = []
  let text = ''
  try {
    for (const rotation of ROTATIONS) {
      const png = join(workDir, `act-${rotation}.png`)
      await prepare(data, rotation, png)
      // Only the automatic layout mode earns its place: sparse-text reads the
      // same page with fewer anchors and then outvotes the good attempts.
      for (const psm of ['3']) {
        let read
        try {
          read = await recognize(png, psm)
        } catch (error) {
          console.error('Act OCR attempt failed', { rotation, psm, error })
          continue
        }
        const parsed = parseActText(read.text)
        if (parsed.anchors < MIN_ANCHORS) continue
        reads.push({ rotation, parsed, confidence: read.confidence })
        if (read.text.length > text.length) text = read.text
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }

  if (!reads.length) {
    return {
      attempts: 0,
      bestRotation: null,
      confidence: 0,
      orderNumber: empty<string>(),
      performedAt: empty<Date>(),
      mileage: empty<number>(),
      totalAmount: empty<number>(),
      isServiceAct: false,
      mentionsOil: false,
      text
    }
  }

  const best = reads.reduce((a, b) => b.parsed.anchors > a.parsed.anchors ? b : a)
  return {
    attempts: reads.length,
    bestRotation: best.rotation,
    confidence: best.confidence,
    // The Cyrillic Ч of the order prefix reads as a Latin 4 about as often as
    // itself, so the two spellings are one value rather than a dispute.
    orderNumber: tally(
      reads.map(read => read.parsed.orderNumber).filter((value): value is string => Boolean(value)),
      normalizeOrderNumber
    ),
    performedAt: tally(
      reads.map(read => read.parsed.performedAt).filter((value): value is Date => value != null),
      value => value.toISOString().slice(0, 10)
    ),
    mileage: tally(
      reads.map(read => read.parsed.mileage).filter((value): value is number => value != null),
      value => String(value)
    ),
    // Only the sum the document prints twice and agrees with itself is offered;
    // a total that fails its own cross-check is worse than no total.
    totalAmount: tally(
      reads.filter(read => read.parsed.totalsAgree)
        .map(read => read.parsed.totalAmount)
        .filter((value): value is number => value != null),
      value => String(value)
    ),
    isServiceAct: reads.some(read => read.parsed.isServiceAct),
    mentionsOil: reads.some(read => read.parsed.mentionsOil),
    text
  }
}
