import { describe, expect, it } from 'vitest'
import { driverKeyboard, tripCompletedText } from '../worker/bot/trip-driver'
import { recipientName } from '../worker/bot/recipients'

const trip = { distance: 28, fuelUsed: 2, driver: null }

function rows(keyboard: ReturnType<typeof driverKeyboard>) {
  return keyboard.inline_keyboard.map(row => row.map(button => button.text))
}

function callbacks(keyboard: ReturnType<typeof driverKeyboard>) {
  return keyboard.inline_keyboard.flat().map(button => 'callback_data' in button ? button.callback_data : '')
}

describe('Вопрос о водителе после поездки', () => {
  it('спрашивает, пока никто не ответил', () => {
    expect(tripCompletedText(trip)).toContain('🧑 Кто был за рулём?')
  })

  it('показывает имя вместо вопроса, когда ответ получен', () => {
    const text = tripCompletedText({ ...trip, driver: 'Игорь' })
    expect(text).toContain('🧑 За рулём: <b>Игорь</b>')
    expect(text).not.toContain('Кто был за рулём')
  })

  it('отличает пропущенный вопрос от незаданного', () => {
    expect(tripCompletedText(trip, { skipped: true })).toContain('🧑 За рулём: не указан')
  })

  it('сохраняет разметку сообщения о поездке', () => {
    expect(tripCompletedText(trip).split('\n')).toEqual([
      '🏁 <b>Поездка завершена</b>',
      '',
      '🛣 Расстояние: 28.0 км',
      '⛽ Топливо: 2.0 л',
      '📊 Расход: 7.1 л/100 км',
      '',
      '🧑 Кто был за рулём?'
    ])
  })

  it('не считает расход, когда делить не на что', () => {
    expect(tripCompletedText({ distance: 0, fuelUsed: 2, driver: null })).toContain('📊 Расход: — л/100 км')
    expect(tripCompletedText({ distance: null, fuelUsed: null, driver: null })).toContain('🛣 Расстояние: — км')
  })

  // Имя приходит из Telegram и в HTML-сообщении окажется как есть.
  it('экранирует имя', () => {
    expect(tripCompletedText({ ...trip, driver: '<b>Игорь</b> & Ко' }))
      .toContain('&lt;b&gt;Игорь&lt;/b&gt; &amp; Ко')
  })
})

describe('Кнопки с именами водителей', () => {
  const igor = { id: 1, username: '@gladyshev', firstName: 'Игорь' }
  const kristina = { id: 2, username: '@kristina', firstName: 'Кристина' }
  const nameless = { id: 3, username: '@driver_three', firstName: null }

  it('ставит имена по двое в ряд, «Пропустить» — отдельной строкой', () => {
    expect(rows(driverKeyboard(7, [igor, kristina]))).toEqual([['Игорь', 'Кристина'], ['Пропустить']])
  })

  it('не сажает «Пропустить» рядом с непарным именем', () => {
    expect(rows(driverKeyboard(7, [igor]))).toEqual([['Игорь'], ['Пропустить']])
    expect(rows(driverKeyboard(7, [igor, kristina, nameless]))).toEqual([
      ['Игорь', 'Кристина'],
      ['driver_three'],
      ['Пропустить']
    ])
  })

  it('поднимает вероятного водителя наверх отдельным рядом', () => {
    // Подсказка нужна, чтобы на вопрос отвечали чаще: за руль отмечена треть
    // поездок, и выбор из четырёх кнопок — главная причина, почему остальные
    // остаются без ответа.
    expect(rows(driverKeyboard(7, [igor, kristina, nameless], 'Кристина'))).toEqual([
      ['✅ Кристина'],
      ['Игорь', 'driver_three'],
      ['Пропустить']
    ])
  })

  it('оставляет порядок как есть, когда угадывать не из чего', () => {
    expect(rows(driverKeyboard(7, [igor, kristina], null))).toEqual([['Игорь', 'Кристина'], ['Пропустить']])
    // Имя из истории, которого больше нет в чате, кнопкой не станет.
    expect(rows(driverKeyboard(7, [igor, kristina], 'Пётр'))).toEqual([['Игорь', 'Кристина'], ['Пропустить']])
  })

  it('несёт в кнопке поездку и получателя, а не имя', () => {
    expect(callbacks(driverKeyboard(42, [igor, kristina]))).toEqual([
      'trip:driver:42:1',
      'trip:driver:42:2',
      'trip:driver:42:skip'
    ])
  })

  it('подписывает кнопку логином, если имени в Telegram нет', () => {
    expect(recipientName(nameless)).toBe('driver_three')
    expect(recipientName(igor)).toBe('Игорь')
    expect(recipientName({ username: '@someone', firstName: '  ' })).toBe('someone')
  })
})
