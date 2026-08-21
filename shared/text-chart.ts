// Telegram has no charts: a message is text, and the only drawing surface it
// gives is a monospace block. Block-element characters turn out to be enough for
// the two shapes that matter here — a month's worth of days as a skyline, and a
// handful of categories as bars — as long as every glyph used is one cell wide.

const LEVELS = '▁▂▃▄▅▆▇█'

export interface BarRow {
  label: string
  value: number
  note: string
}

// A day with no distance is left as a dot rather than the lowest block, so that
// «did not drive» and «drove a little» stay visibly different.
export function sparkline(values: number[], empty = '·') {
  const max = Math.max(...values, 0)
  if (!(max > 0)) return empty.repeat(values.length)
  return values.map((value) => {
    if (!(value > 0)) return empty
    return LEVELS[Math.min(LEVELS.length - 1, Math.floor(value / max * LEVELS.length))]
  }).join('')
}

// Day numbers written under the skyline, each starting exactly beneath its own
// column, so a spike can be read off as a date without counting characters.
export function dayScale(days: number) {
  let line = ''
  for (const day of [1, 5, 10, 15, 20, 25, 30]) {
    if (day > days) break
    const at = day - 1
    if (at < line.length) continue
    line = line.padEnd(at) + String(day)
  }
  return line
}

export function barChart(rows: BarRow[], width = 11) {
  const max = Math.max(...rows.map(row => row.value), 0)
  const labelWidth = Math.max(...rows.map(row => row.label.length), 0)
  const noteWidth = Math.max(...rows.map(row => row.note.length), 0)
  return rows.map((row) => {
    // Anything above zero keeps at least one block: an empty track next to a
    // non-zero number reads as a bug rather than as a small value.
    const filled = max > 0 && row.value > 0 ? Math.max(1, Math.round(row.value / max * width)) : 0
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
    return `${row.label.padEnd(labelWidth)} ${bar} ${row.note.padStart(noteWidth)}`
  })
}
