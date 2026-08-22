// Русские числительные: 1 поездка, 2 поездки, 5 поездок. Нужны и в отчётах, и в
// статистике, поэтому живут отдельно от обоих.
export function plural(count: number, one: string, few: string, many: string) {
  const value = Math.abs(Math.round(count))
  if (value % 100 >= 11 && value % 100 <= 14) return many
  const last = value % 10
  if (last === 1) return one
  return last >= 2 && last <= 4 ? few : many
}
