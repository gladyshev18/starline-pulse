import { createDatabase } from '../db/client'
import { recomputeTrips } from '../worker/starline/recompute'

// Разовый проход по накопленной истории: досылка одометра возвращается той
// поездке, которая эти километры проехала. Без --apply только показывает, что
// будет сделано.
const apply = process.argv.includes('--apply')
const database = createDatabase()

try {
  const report = await recomputeTrips(database, { apply })

  console.log(`Сессии, забравшие досылку: ${report.sessionsExtended.length}`)
  for (const item of report.sessionsExtended) {
    console.log(`  сессия #${item.id} → ${item.distance} км${item.wasStationary ? ' (числилась прогревом)' : ''}`)
  }

  console.log(`\nПоездки, перенесённые на свою сессию: ${report.tripsReanchored.length}`)
  for (const item of report.tripsReanchored) {
    console.log(`  поездка #${item.id} → сессия #${item.sessionId}, старт ${item.startedAt.toISOString()}`)
  }

  console.log(`\nПоездки, слитые с настоящей: ${report.tripsMerged.length}`)
  for (const item of report.tripsMerged) {
    console.log(`  поездка #${item.id} (${item.distance} км) → #${item.intoId}`)
  }

  if (report.phantomsLeft.length) {
    console.log(`\nОставлены без изменений (одометр не сходится): ${report.phantomsLeft.length}`)
    for (const item of report.phantomsLeft) {
      console.log(`  поездка #${item.id} ${item.startedAt.toISOString()} ${item.distance} км`)
    }
  }

  if (report.tripsCreated.length) {
    console.log(`\nЗаведены поездки для сессий, которые ехали без записи: ${report.tripsCreated.length}`)
    for (const item of report.tripsCreated) {
      console.log(`  сессия #${item.sessionId} ${item.startedAt.toISOString()} → ${item.distance} км`)
    }
  }

  if (report.tripsEmptied.length) {
    console.log(`\nОказались прогревом, а не поездкой: ${report.tripsEmptied.length}`)
    for (const item of report.tripsEmptied) {
      console.log(`  поездка #${item.id} ${item.startedAt.toISOString()}${item.kept ? ' — оставлена, есть комментарий или водитель' : ' — удалена'}`)
    }
  }

  console.log(`\nПересчитано поездок: ${report.tripsRewritten.length}`)
  for (const item of report.tripsRewritten) {
    const changes = Object.entries(item.changes).map(([key, value]) => `${key}: ${value.from} → ${value.to}`)
    console.log(`  поездка #${item.id}: ${changes.join(', ')}`)
  }

  const drift = report.distanceAfter - report.distanceBefore
  console.log(`\nПробег по поездкам: ${report.distanceBefore} → ${report.distanceAfter} км (расхождение ${drift})`)
  console.log(`Одометр за тот же период: ${report.odometerSpan} км`)
  if (drift !== 0 || (report.odometerSpan != null && report.distanceAfter !== report.odometerSpan)) {
    console.log('ВНИМАНИЕ: километры не сошлись, разбор нужно проверить до записи.')
  }

  console.log(apply ? '\nИзменения записаны.' : '\nПробный прогон. Повторите с --apply, чтобы записать.')
} finally {
  database.$client.close()
}
