import { readFile, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const protectedTables = ['api_calls', 'vehicle_snapshots', 'trips'] as const
const sourceRoots = ['db', 'scripts', 'server', 'worker'] as const

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
