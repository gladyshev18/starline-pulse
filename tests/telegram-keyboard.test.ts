import { describe, expect, it } from 'vitest'
import { buttonLabels, mainKeyboard } from '../worker/bot/keyboard'

describe('Telegram bot keyboard', () => {
  it('contains all primary actions in a compact layout', () => {
    expect(mainKeyboard.keyboard.map(row => row.map(button => typeof button === 'string' ? button : button.text))).toEqual([
      [buttonLabels.status, buttonLabels.fuel],
      [buttonLabels.last],
      [buttonLabels.day],
      [buttonLabels.week, buttonLabels.month]
    ])
  })

  it('stays visible and uses a compact client layout', () => {
    expect(mainKeyboard.is_persistent).toBe(true)
    expect(mainKeyboard.resize_keyboard).toBe(true)
    expect(mainKeyboard.input_field_placeholder).toBe('Выберите, что показать')
  })
})
