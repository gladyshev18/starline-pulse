import { describe, expect, it } from 'vitest'
import { departureFromOdometer } from '../metrics/odometer'

// Отметки отъезда в данных нет. Ручник приходит через полминуты после зажигания
// и говорит только о том, что блок проснулся; счётчик моточасов идёт и на
// стоянке; координаты вышечные. Остаётся одометр: первое показание задаёт темп,
// и по нему видно, сколько времени до него машина ехать не могла.
describe('когда машина тронулась — по одометру', () => {
  const base = Date.parse('2026-09-20T14:16:43.000Z')
  const at = (minute: number) => new Date(base + minute * 60_000)
  const reading = (minute: number, value: number) => ({ value, at: at(minute) })
  const minutesAfterStart = (moment: Date | null) => moment == null ? null : (moment.getTime() - base) / 60_000

  const trip = (mileageStart: number | null, endMinute: number) => ({
    startedAt: at(0), endedAt: at(endMinute), mileageStart
  })

  // Поездка 20 сентября: зажигание в 17:16, первое показание в 17:25 и всего
  // три километра к нему, а дальше 114 км за 99 минут. Тремя километрами эти
  // девять минут не занять.
  it('вычитает стоянку, которой не хватает километров', () => {
    const moved = departureFromOdometer(
      [reading(9.2, 20660), reading(108.2, 20774)],
      trip(20657, 108.2)
    )
    // Три километра ходом 69 км/ч — две с половиной минуты, остальное стоянка.
    expect(minutesAfterStart(moved)).toBeCloseTo(6.6, 1)
  })

  it('молчит, когда километры покрывают весь промежуток', () => {
    // Двадцать километров за первые двадцать минут — тем же ходом, что и дальше.
    expect(departureFromOdometer(
      [reading(20, 20677), reading(80, 20737)],
      trip(20657, 80)
    )).toBeNull()
  })

  // Одно показание за поездку не говорит ни о каком темпе: те же километры могли
  // быть проеханы и за десять минут, и за две. Раньше здесь брали отметку первого
  // хода как есть — и короткая поездка получала 470 км/ч.
  it('не трогает поездку с единственным показанием', () => {
    expect(departureFromOdometer([reading(14, 20666)], trip(20657, 16))).toBeNull()
  })

  it('не трогает поездку, у которой одометр на старте неизвестен', () => {
    expect(departureFromOdometer(
      [reading(9, 20660), reading(100, 20774)],
      trip(null, 108)
    )).toBeNull()
  })

  // Показания стоят на месте: машина работала на холостом, темпа нет и оценивать
  // нечем.
  it('не трогает поездку, в которой одометр не сдвинулся', () => {
    expect(departureFromOdometer(
      [reading(9, 20660), reading(100, 20660)],
      trip(20657, 108)
    )).toBeNull()
  })

  it('не считает показания соседей — только свои', () => {
    const moved = departureFromOdometer(
      [reading(-30, 20650), reading(9.2, 20660), reading(108.2, 20774), reading(200, 20800)],
      trip(20657, 108.2)
    )
    expect(minutesAfterStart(moved)).toBeCloseTo(6.6, 1)
  })

  // Темп считается по остатку поездки вместе с её собственными остановками,
  // поэтому он занижен, а занижённый темп отдаёт езде больше минут и стоянку
  // укорачивает. Ошибка в эту сторону безопасна: скорость выйдет меньше
  // настоящей, а не больше.
  it('скорее недооценит стоянку, чем переоценит', () => {
    const moved = departureFromOdometer(
      // После первого показания машина полчаса стояла в пробке: темп выходит 30
      // км/ч вместо трассовых, и три километра «едут» шесть минут.
      [reading(10, 20660), reading(70, 20690)],
      trip(20657, 70)
    )
    expect(minutesAfterStart(moved)).toBeCloseTo(4, 1)
  })
})
