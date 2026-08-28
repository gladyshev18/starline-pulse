import { readFile, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const protectedTables = ['api_calls', 'vehicle_snapshots', 'trips'] as const
const sourceRoots = ['db', 'scripts', 'server', 'worker'] as const

// Убрать строку из trips позволено ровно двум местам, и обоим по одной причине:
// они удаляют не историю. Запись, у которой одометр за всё время не сдвинулся, —
// это прогрев, а машина никуда не ехала. Сам прогрев при этом никуда не
// девается: он остаётся сессией двигателя, и счёт холостого хода считает его
// именно там. Ни снапшотов, ни сессий не трогает ни один из них — а нельзя
// восстановить как раз это.
//
// Имя водителя такую запись не защищает: бот спрашивает про каждую закрытую
// поездку сам, и ответ на его вопрос не означает, что человек считает эту
// строку поездкой. Комментарий защищает — его писали руками, и текст больше
// нигде не хранится.
//
// Проверка на ноль стоит не в момент закрытия поездки: одометр досылает остаток
// минутами позже, и запись, у которой в ту минуту был ноль, запросто оказывается
// настоящей дорогой. Оба места смотрят на неё тогда, когда окно досылки уже
// закрылось. Живой путь опроса по-прежнему только дописывает километры в уже
// существующую поездку и ничего не стирает.
const allowedToDelete = new Set([
  join('worker', 'starline', 'recompute.ts'),
  join('worker', 'starline', 'events.ts')
])

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return extname(entry.name) === '.ts' || extname(entry.name) === '.sql' ? [path] : []
  }))
  return files.flat()
}

describe('data retention', () => {
  it('does not contain deletion logic for historical vehicle data', async () => {
    const files = (await Promise.all(sourceRoots.map(sourceFiles))).flat()
    const violations: string[] = []

    for (const file of files) {
      if (allowedToDelete.has(file)) continue
      const source = await readFile(file, 'utf8')
      for (const table of protectedTables) {
        const schemaName = table.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
        const optionalQuote = '["\'`]?'
        const patterns = [
          new RegExp(`delete\\s+from\\s+${optionalQuote}${table}${optionalQuote}`, 'i'),
          new RegExp(`\\.delete\\(\\s*${schemaName}\\s*\\)`),
          new RegExp(`drop\\s+table(?:\\s+if\\s+exists)?\\s+${optionalQuote}${table}${optionalQuote}`, 'i'),
          new RegExp(`truncate(?:\\s+table)?\\s+${optionalQuote}${table}${optionalQuote}`, 'i')
        ]
        if (patterns.some(pattern => pattern.test(source))) violations.push(`${file}: ${table}`)
      }
    }

    expect(violations, 'Historical data must be retained indefinitely').toEqual([])
  })
})
