import { Keyboard } from 'grammy'

export const buttonLabels = {
  status: '🚗 Состояние',
  fuel: '⛽ Сколько заправить',
  last: '🛣 Последние поездки',
  stats: '📈 Статистика',
  day: '📊 Отчёт за вчера',
  week: '📅 Прошлая неделя',
  month: '🗓 Прошлый месяц'
} as const

// Клавиатура не закреплена: Telegram сам рисует значок сворачивания рядом с
// полем ввода, и меню убирается одним касанием, не отнимая пол-экрана у
// переписки. Разворачивается тем же значком или командой /menu.
export const mainKeyboard = new Keyboard()
  .text(buttonLabels.status)
  .text(buttonLabels.fuel)
  .row()
  .text(buttonLabels.last)
  .text(buttonLabels.stats)
  .row()
  .text(buttonLabels.day)
  .text(buttonLabels.week)
  .row()
  .text(buttonLabels.month)
  .resized()
  .placeholder('Выберите, что показать')

// Совсем убрать меню умеет только сообщение с этой разметкой; вернуть его —
// сообщение с mainKeyboard. Поэтому обычные ответы клавиатуру не прикладывают:
// иначе спрятанное меню возвращалось бы первым же отчётом.
export const hiddenKeyboard = { remove_keyboard: true } as const
