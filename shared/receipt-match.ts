import { FUEL_TANK_CAPACITY_LITRES } from './fuel'

// The OBD fuel level only refreshes while the engine runs, so a refuel event is
// detected after the purchase — sometimes only on the next morning's start. The
// window is therefore wide backwards and nearly closed forwards.
export const MATCH_WINDOW_BEFORE_MS = 24 * 60 * 60_000
export const MATCH_WINDOW_AFTER_MS = 15 * 60_000
export const MATCH_EXACT_TIME_MS = 30 * 60_000
export const AUTO_MATCH_SCORE = 0.8
export const SUGGEST_MATCH_SCORE = 0.5
export const AUTO_MATCH_MARGIN = 0.2
export const VOLUME_TOLERANCE_LITRES = 2
export const VOLUME_TOLERANCE_RATIO = 0.15
// Percent readings are coarse, so a volume derived from them earns a wider allowance.
export const DERIVED_VOLUME_TOLERANCE_RATIO = 0.3
const TIME_WEIGHT = 0.6
const VOLUME_WEIGHT = 0.4
const OCCUPIED_EVENT_PENALTY = 0.15

export type ReceiptMatchInput = {
  purchasedAt: Date | string | number | null
  litres?: number | null
}

export type RefuelMatchCandidate = {
  id: number
  detectedAt: Date | string | number
  litresAdded?: number | null
  percentBefore?: number | null
  percentAfter?: number | null
  hasReceipt?: boolean
}

export type ScoredRefuelCandidate = {
  refuelEventId: number
  score: number
  timeScore: number
  volumeScore: number | null
  minutesApart: number
  litresDifference: number | null
}

export type ReceiptMatchResult = {
  status: 'auto' | 'suggested' | 'unmatched'
  refuelEventId: number | null
  score: number | null
  candidates: ScoredRefuelCandidate[]
}

function timestamp(value: Date | string | number | null | undefined) {
  if (value == null) return null
  const result = new Date(value).getTime()
  return Number.isFinite(result) ? result : null
}

function positive(value: number | null | undefined) {
  return value != null && Number.isFinite(value) && value > 0 ? value : null
}

export function refuelVolume(refuel: RefuelMatchCandidate) {
  const measured = positive(refuel.litresAdded)
  if (measured != null) return { litres: measured, derived: false }

  const before = refuel.percentBefore
  const after = refuel.percentAfter
  if (before == null || after == null || !Number.isFinite(before) || !Number.isFinite(after) || after <= before) return null
  return { litres: (after - before) / 100 * FUEL_TANK_CAPACITY_LITRES, derived: true }
}

function scoreTime(minutesApart: number, withinWindow: boolean) {
  if (!withinWindow) return null
  const exactMinutes = MATCH_EXACT_TIME_MS / 60_000
  if (minutesApart <= exactMinutes) return 1
  const spread = MATCH_WINDOW_BEFORE_MS / 60_000 - exactMinutes
  return 1 - 0.8 * ((minutesApart - exactMinutes) / spread)
}

function scoreVolume(receiptLitres: number, refuel: RefuelMatchCandidate) {
  const volume = refuelVolume(refuel)
  if (!volume) return { score: null, difference: null }

  const ratio = volume.derived ? DERIVED_VOLUME_TOLERANCE_RATIO : VOLUME_TOLERANCE_RATIO
  const tolerance = Math.max(VOLUME_TOLERANCE_LITRES, receiptLitres * ratio)
  const difference = Math.abs(receiptLitres - volume.litres)
  if (difference > tolerance * 2) return { score: 0, difference, rejected: true }
  if (difference <= tolerance) return { score: 1 - 0.3 * (difference / tolerance), difference }
  return { score: 0.7 * (1 - (difference - tolerance) / tolerance), difference }
}

export function scoreRefuelCandidate(receipt: ReceiptMatchInput, refuel: RefuelMatchCandidate): ScoredRefuelCandidate | null {
  const purchasedAt = timestamp(receipt.purchasedAt)
  const detectedAt = timestamp(refuel.detectedAt)
  if (purchasedAt == null || detectedAt == null) return null

  const delta = detectedAt - purchasedAt
  const withinWindow = delta >= -MATCH_WINDOW_AFTER_MS && delta <= MATCH_WINDOW_BEFORE_MS
  const minutesApart = Math.abs(delta) / 60_000
  const timeScore = scoreTime(minutesApart, withinWindow)
  if (timeScore == null) return null

  const receiptLitres = positive(receipt.litres)
  const volume = receiptLitres == null ? { score: null, difference: null } : scoreVolume(receiptLitres, refuel)
  if ('rejected' in volume && volume.rejected) return null

  // Without a comparable volume the time alone decides, and the result is
  // deliberately held below the automatic threshold so a person confirms it.
  const combined = volume.score == null
    ? Math.min(timeScore, AUTO_MATCH_SCORE - 0.01)
    : timeScore * TIME_WEIGHT + volume.score * VOLUME_WEIGHT
  const score = Math.max(0, combined - (refuel.hasReceipt ? OCCUPIED_EVENT_PENALTY : 0))

  return {
    refuelEventId: refuel.id,
    score: Math.round(score * 1000) / 1000,
    timeScore: Math.round(timeScore * 1000) / 1000,
    volumeScore: volume.score == null ? null : Math.round(volume.score * 1000) / 1000,
    minutesApart: Math.round(minutesApart),
    litresDifference: volume.difference == null ? null : Math.round(volume.difference * 100) / 100
  }
}

export function matchReceipt(receipt: ReceiptMatchInput, candidates: RefuelMatchCandidate[]): ReceiptMatchResult {
  const scored = candidates
    .map(candidate => scoreRefuelCandidate(receipt, candidate))
    .filter((candidate): candidate is ScoredRefuelCandidate => candidate != null)
    .sort((left, right) => right.score - left.score || left.minutesApart - right.minutesApart)

  const best = scored[0]
  if (!best || best.score < SUGGEST_MATCH_SCORE) {
    return { status: 'unmatched', refuelEventId: null, score: best?.score ?? null, candidates: scored.slice(0, 3) }
  }

  const runnerUp = scored[1]
  const decisive = !runnerUp || best.score - runnerUp.score >= AUTO_MATCH_MARGIN
  const status = best.score >= AUTO_MATCH_SCORE && decisive ? 'auto' : 'suggested'
  return { status, refuelEventId: best.refuelEventId, score: best.score, candidates: scored.slice(0, 3) }
}
