import { monthStatistics } from '../../metrics/statistics'
import { moscowMonthRange } from '../../shared/moscow-month'

export default defineEventHandler(async (event) => {
  const requestedMonth = getQuery(event).month
  const range = moscowMonthRange(requestedMonth)
  if (!range || (requestedMonth != null && requestedMonth !== range.month)) {
    throw createError({ statusCode: 400, statusMessage: 'Месяц должен быть указан в формате ГГГГ-ММ' })
  }

  return monthStatistics(useAppDatabase(), range)
})
