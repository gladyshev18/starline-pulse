import { sql } from 'drizzle-orm'
import { createDatabase } from '../db/client'
import { engineSessions } from '../db/schema'
import { recomputeTrips } from '../worker/starline/recompute'

// Разовый проход по накопленной истории: границы поездок берутся из журнала
// сигнализации, километры раскладываются между всеми, кто ехал в промежутке
// между показаниями одометра. Без --apply только показывает текущее состояние.
const apply = process.argv.includes('--apply')
const database = createDatabase()
const date = (value: Date) => value.toISOString().replace('T', ' ').slice(0, 19)

try {
  const report = await recomputeTrips(database, { apply })

  if (!apply) {
    console.log('Пробный прогон ничего не считает: разбор работает по самой базе.')
    console.log(`Сейчас поездок на ${report.distanceBefore} км, одометр за тот же период ${report.odometerSpan} км.`)
    console.log('Повторите с --apply, чтобы пересчитать.')
  } else {
    console.log(`Границы уточнены у сессий: ${report.sessionsCorrected}`)
    console.log(`Заведено сессий, которые опрос проспал: ${report.sessionsCreated}`)
    console.log(`Пересчитан пробег у сессий: ${report.sessionsUpdated}`)
    console.log(`Пересчитано поездок: ${report.tripsUpdated}`)

    if (report.tripsCreated.length) {
      console.log(`\nЗаведены поездки для дорог без записи: ${report.tripsCreated.length}`)
      for (const item of report.tripsCreated) console.log(`  ${date(item.startedAt)} — ${item.distance.toFixed(1)} км`)
    }
    if (report.tripsRemoved.length) {
      console.log(`\nОказались прогревом и сняты: ${report.tripsRemoved.length}`)
      for (const item of report.tripsRemoved) console.log(`  ${date(item.startedAt)}`)
    }

    console.log(`\nПробег по поездкам: ${report.distanceBefore} → ${report.distanceAfter.toFixed(1)} км`)
    console.log(`Одометр за тот же период: ${report.odometerSpan} км`)
    if (report.unattributed) {
      console.log(`Не досталось никому: ${report.unattributed} км — двигатель в это время не работал ни минуты.`)
    }
    // Сверяется не журнал поездок, а сессии: доли меньше половины километра в
    // журнал не попадают намеренно, и разница на них — не ошибка.
    const [sessions] = await database.select({
      total: sql<number>`coalesce(sum(${engineSessions.distance}), 0)`
    }).from(engineSessions)
    const total = Number(sessions?.total ?? 0)
    const drift = total + report.unattributed - (report.odometerSpan ?? 0)
    console.log(`Пробег по сессиям: ${total.toFixed(1)} км`)
    if (Math.abs(drift) > 0.5) console.log(`ВНИМАНИЕ: километры не сошлись с одометром на ${drift.toFixed(1)}, разбор нужно проверить.`)
    else console.log('Километры сошлись с одометром.')
    const skipped = total - report.distanceAfter
    if (skipped > 0.05) console.log(`В журнал поездок не попало ${skipped.toFixed(1)} км: доли меньше половины километра.`)
  }
} finally {
  database.$client.close()
}
