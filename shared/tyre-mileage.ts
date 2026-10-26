import type { TyreSeason } from './tyres'

// Пробег на летней и на зимней резине. Резина не носит счётчика, поэтому
// считается по тому, что есть: каждая смена фиксирует показание одометра, и
// отрезок от одной смены до следующей — это километры того сезона, на который
// поставили. Последний отрезок тянется до сегодняшнего одометра и считается
// идущим.
//
// До первой записанной смены пробег неизвестен: чем ездили раньше, журнал не
// знает, и выдумывать этот кусок значило бы приписать сезону чужие километры.

export interface TyreChange {
  id: number
  performedAt: Date
  mileage: number | null
  season: TyreSeason
  amount: number | null
}

export interface TyreSegment {
  id: number
  season: TyreSeason
  from: Date
  // Пусто у идущего отрезка: он ещё не закончился.
  to: Date | null
  startKm: number | null
  endKm: number | null
  // Пусто, если у одного из концов нет показания одометра.
  km: number | null
  // Сумма шиномонтажа, которым этот отрезок начался.
  amount: number | null
  current: boolean
}

export interface TyreSeasonTotal {
  km: number
  // Сколько отрезков вошло в сумму. Отрезок без пробега в неё не попадает.
  segments: number
}

export interface TyreMileage {
  segments: TyreSegment[]
  totals: Record<TyreSeason, TyreSeasonTotal>
  // Сколько стоили смены, у которых сумма известна, и сколько их было.
  spent: number
  priced: number
  changes: number
}

// Показание в журнале и показание сейчас приходят из разных опросов, и вторая
// может оказаться меньше первой, если запись внесли с пробегом «из головы».
// Отрицательные километры хуже отсутствующих: они молча вычитаются из суммы.
function distance(start: number | null, end: number | null) {
  if (start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end)) return null
  return end >= start ? end - start : null
}

export function tyreMileage(changes: TyreChange[], odometer: number | null): TyreMileage {
  const ordered = [...changes].sort((left, right) => left.performedAt.getTime() - right.performedAt.getTime())

  const segments = ordered.map((change, index): TyreSegment => {
    const next = ordered[index + 1]
    const endKm = next ? next.mileage : odometer
    return {
      id: change.id,
      season: change.season,
      from: change.performedAt,
      to: next?.performedAt ?? null,
      startKm: change.mileage,
      endKm,
      km: distance(change.mileage, endKm),
      amount: change.amount,
      current: !next
    }
  })

  const totals: Record<TyreSeason, TyreSeasonTotal> = {
    winter: { km: 0, segments: 0 },
    summer: { km: 0, segments: 0 }
  }
  for (const segment of segments) {
    if (segment.km == null) continue
    totals[segment.season].km += segment.km
    totals[segment.season].segments++
  }

  const paid = ordered.filter(change => change.amount != null && change.amount > 0)
  return {
    segments,
    totals,
    spent: paid.reduce((sum, change) => sum + change.amount!, 0),
    priced: paid.length,
    changes: ordered.length
  }
}

// Зимний сезон живёт на стыке годов, и «зима 2025» читается как та, что
// кончилась, а не как та, что началась. Поэтому у зимы две цифры, у лета одна.
// Месяц берётся по Москве: смена 31 декабря в полночь не должна уезжать в
// другой год из-за часового пояса сервера.
export function tyreSeasonLabel(season: TyreSeason, at: Date) {
  const moscow = new Date(at.getTime() + 3 * 60 * 60_000)
  const year = moscow.getUTCFullYear()
  if (season === 'summer') return `Лето ${year}`
  // Зимняя резина, поставленная в январе-марте, относится к зиме, начавшейся
  // в прошлом году.
  const start = moscow.getUTCMonth() < 6 ? year - 1 : year
  return `Зима ${start}/${String(start + 1).slice(-2)}`
}
