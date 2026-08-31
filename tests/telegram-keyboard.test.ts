import { describe, expect, it } from 'vitest'
import { buttonLabels, hiddenKeyboard, mainKeyboard } from '../worker/bot/keyboard'

describe('Telegram bot keyboard', () => {
  it('contains all primary actions in a compact layout', () => {
    expect(mainKeyboard.keyboard.map(row => row.map(button => typeof button === 'string' ? button : button.text))).toEqual([
      [buttonLabels.status, buttonLabels.fuel],
      [buttonLabels.last, buttonLabels.stats],
      [buttonLabels.day, buttonLabels.week],
      [buttonLabels.month]
    ])
  })

  it('uses a compact client layout and can be collapsed', () => {
    expect(mainKeyboard.resize_keyboard).toBe(true)
    expect(mainKeyboard.input_field_placeholder).toBe('Выберите, что показать')
    // Закреплённую клавиатуру Telegram не даёт свернуть значком у поля ввода.
    expect(mainKeyboard.is_persistent).toBeUndefined()
  })

  it('offers a way to remove the keyboard entirely', () => {
    expect(hiddenKeyboard).toEqual({ remove_keyboard: true })
  })
})
