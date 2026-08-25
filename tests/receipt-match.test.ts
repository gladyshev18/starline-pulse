import { describe, expect, it } from 'vitest'
import { matchReceipt, refuelVolume, scoreRefuelCandidate } from '../shared/receipt-match'

const detectedAt = new Date('2026-08-14T09:00:00.000Z')

function purchasedMinutesBefore(minutes: number) {
  return new Date(detectedAt.getTime() - minutes * 60_000)
}

describe('refuelVolume', () => {
  it('prefers the measured litres', () => {
    expect(refuelVolume({ id: 1, detectedAt, litresAdded: 38.4, percentBefore: 10, percentAfter: 90 }))
      .toEqual({ litres: 38.4, derived: false })
  })

  it('derives litres from the percent jump when the sensor gave none', () => {
    const volume = refuelVolume({ id: 1, detectedAt, litresAdded: null, percentBefore: 20, percentAfter: 80 })
    expect(volume!.litres).toBeCloseTo(30.6)
    expect(volume!.derived).toBe(true)
  })

  it('gives up when neither volume nor a percent increase is known', () => {
    expect(refuelVolume({ id: 1, detectedAt, litresAdded: null, percentBefore: 80, percentAfter: 80 })).toBeNull()
  })
})

describe('scoreRefuelCandidate', () => {
  it('rejects a receipt bought after the level was already reported', () => {
    const receipt = { purchasedAt: new Date(detectedAt.getTime() + 60 * 60_000), litres: 40 }
    expect(scoreRefuelCandidate(receipt, { id: 1, detectedAt, litresAdded: 40 })).toBeNull()
  })

  it('rejects a receipt older than the search window', () => {
    const receipt = { purchasedAt: purchasedMinutesBefore(48 * 60), litres: 40 }
    expect(scoreRefuelCandidate(receipt, { id: 1, detectedAt, litresAdded: 40 })).toBeNull()
  })

  it('rejects a volume that is nowhere near the detected one', () => {
    const receipt = { purchasedAt: purchasedMinutesBefore(30), litres: 40 }
    expect(scoreRefuelCandidate(receipt, { id: 1, detectedAt, litresAdded: 8 })).toBeNull()
  })

  it('tolerates the sensor being off by a litre', () => {
    const receipt = { purchasedAt: purchasedMinutesBefore(20), litres: 40 }
    const scored = scoreRefuelCandidate(receipt, { id: 1, detectedAt, litresAdded: 39 })
    expect(scored?.litresDifference).toBe(1)
    expect(scored?.score).toBeGreaterThan(0.9)
  })

  it('scores a detection on the next morning below a fresh one', () => {
    const receipt = { purchasedAt: purchasedMinutesBefore(14 * 60), litres: 40 }
    const overnight = scoreRefuelCandidate(receipt, { id: 1, detectedAt, litresAdded: 40 })
    const fresh = scoreRefuelCandidate({ purchasedAt: purchasedMinutesBefore(20), litres: 40 }, { id: 2, detectedAt, litresAdded: 40 })
    expect(overnight!.score).toBeLessThan(fresh!.score)
    expect(overnight!.score).toBeGreaterThan(0)
  })

  it('penalises an event that already carries a receipt', () => {
    const receipt = { purchasedAt: purchasedMinutesBefore(20), litres: 40 }
    const free = scoreRefuelCandidate(receipt, { id: 1, detectedAt, litresAdded: 40 })
    const taken = scoreRefuelCandidate(receipt, { id: 2, detectedAt, litresAdded: 40, hasReceipt: true })
    expect(free!.score - taken!.score).toBeCloseTo(0.15, 3)
  })

  it('ignores a receipt without a purchase time', () => {
    expect(scoreRefuelCandidate({ purchasedAt: null, litres: 40 }, { id: 1, detectedAt, litresAdded: 40 })).toBeNull()
  })
})

describe('matchReceipt', () => {
  it('links a receipt automatically when one event fits by time and volume', () => {
    const result = matchReceipt({ purchasedAt: purchasedMinutesBefore(25), litres: 41.2 }, [
      { id: 10, detectedAt, litresAdded: 41 },
      { id: 11, detectedAt: new Date(detectedAt.getTime() - 20 * 24 * 60 * 60_000), litresAdded: 41 }
    ])
    expect(result).toMatchObject({ status: 'auto', refuelEventId: 10 })
  })

  it('only suggests when two events fit equally well', () => {
    const result = matchReceipt({ purchasedAt: purchasedMinutesBefore(25), litres: 40 }, [
      { id: 10, detectedAt, litresAdded: 40 },
      { id: 11, detectedAt: new Date(detectedAt.getTime() + 10 * 60_000), litresAdded: 40 }
    ])
    expect(result.status).toBe('suggested')
    expect(result.candidates).toHaveLength(2)
  })

  it('never links automatically while the volume cannot be compared', () => {
    const result = matchReceipt({ purchasedAt: purchasedMinutesBefore(10), litres: null }, [
      { id: 10, detectedAt, litresAdded: null }
    ])
    expect(result).toMatchObject({ status: 'suggested', refuelEventId: 10 })
  })

  it('uses the percent jump when the sensor reported no litres', () => {
    const result = matchReceipt({ purchasedAt: purchasedMinutesBefore(15), litres: 30 }, [
      { id: 10, detectedAt, litresAdded: null, percentBefore: 20, percentAfter: 80 }
    ])
    expect(result).toMatchObject({ status: 'auto', refuelEventId: 10 })
  })

  it('leaves a receipt unmatched when nothing is close', () => {
    const result = matchReceipt({ purchasedAt: purchasedMinutesBefore(20), litres: 40 }, [
      { id: 10, detectedAt: new Date(detectedAt.getTime() - 5 * 24 * 60 * 60_000), litresAdded: 40 }
    ])
    expect(result).toMatchObject({ status: 'unmatched', refuelEventId: null, candidates: [] })
  })
})
