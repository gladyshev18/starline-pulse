import { Keyboard } from 'grammy'

export const buttonLabels = {
  status: '🚗 Состояние',
  fuel: '⛽ Сколько заправить',
  last: '🛣 Последние поездки',
  day: '📊 Отчёт за вчера',
  week: '📅 Прошлая неделя',
  month: '🗓 Прошлый месяц'
} as const

export const mainKeyboard = new Keyboard()
  .text(buttonLabels.status)
  .text(buttonLabels.fuel)
  .row()
  .text(buttonLabels.last)
  .row()
  .text(buttonLabels.day)
  .row()
  .text(buttonLabels.week)
  .text(buttonLabels.month)
  .resized()
  .persistent()
  .placeholder('Выберите, что показать')
