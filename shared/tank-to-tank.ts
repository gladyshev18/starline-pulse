import { FUEL_SENSOR_STEP_LITRES, FUEL_TANK_CAPACITY_LITRES } from './fuel'

// Сколько литров помещается сверх того места, где датчик упёрся в сотню. Шкала
// процентов кончается раньше, чем горловина: у заправок, залитых «под горло»,
// чек стабильно больше того, что датчик считает свободным объёмом, — на 0,8,
// 0,8, 1,3, 2,3 и 3,1 л. Само по себе это смещение расходу не мешает: от бака
// до бака сравниваются два одинаково полных бака, и постоянная добавка в
// разности исчезает. Мешает разброс — колонка отсекается по-разному, машина
// стоит под уклоном, бензин теплее или холоднее.
export const FULL_TANK_SLACK_LITRES = 0.7

// Тот же разброс, но для конца, залитого не до полного. Там в расчёт входит уже
// не упор шкалы, а само её показание, и врёт оно не округлением в один процент,
// а формой бака: поплавок линеен, бак — нет. Два процента ёмкости — то, во что
// такая нелинейность укладывается, и это вшестеро хуже полного бака.
export const SENSOR_LEVEL_SLACK_LITRES = FUEL_TANK_CAPACITY_LITRES * 0.02

// Одометр приходит кусками: за всю историю 280 приращений, медиана 5 км, девятый
// дециль 13 км, максимум 30. В любой момент показание отстаёт от настоящего
// пробега на случайную часть такого куска, и у перегона таких отставаний два —
// на входе и на выходе.
export const ODOMETER_REPORT_STEP_KM = 10

// Равномерная ошибка на отрезке имеет среднеквадратичное отклонение в корень из
// двенадцати раз меньше его длины.
const UNIFORM_SIGMA = 1 / Math.sqrt(12)

// Доля, при которой измерение перестаёт быть измерением, — та же треть, что и у
// поездок: «10 л/100 км» с границей в 3,3 нельзя сравнить ни с чем.
export const MAX_ERROR_SHARE = 1 / 3

export type TankLegDoubt = 'partial' | 'estimated' | 'short'

export const TANK_LEG_DOUBT_LABELS: Record<TankLegDoubt, string> = {
  partial: 'Один из баков залит не до полного',
  estimated: 'Литры по датчику, без чека',
  short: 'Слишком короткий перегон для такой точности'
}

export interface TankRefuel {
  id: number
  detectedAt: Date
  mileage: number | null
  fuelAfter: number | null
  percentAfter: number | null
  // Лучший известный объём: чек, если он есть, иначе показание датчика.
  litresAdded: number | null
  // Подтверждён ли объём чеком.
  confirmed: boolean
  // Что именно залили. Известно из чека, поэтому у заправки без чека пусто.
  fuelType: string | null
  station: string | null
  stationName: string | null
}

export interface TankLeg {
  fromId: number
  toId: number
  from: Date
  to: Date
  fromMileage: number
  toMileage: number
  distance: number
  litres: number
  consumption: number
  // Литры и километры со своими погрешностями — наружу отдаются порознь, чтобы
  // сумма перегонов складывала не проценты, а сами ошибки.
  litresError: number
  distanceError: number
  errorBound: number
  // Оба конца залиты под горло. Только тогда литры перегона — это ровно то, что
  // написано в чеке, и датчик в расчёт не входит вовсе.
  full: boolean
  confirmed: boolean
  doubts: TankLegDoubt[]
  // Чем ехали — с открывающей заправки, а не с закрывающей. Литры перегона
  // берутся из второго чека, но это мерка, а не топливо: столько ушло из бака,
  // столько потом и влезло обратно. В двигатель за эти километры уходило то,
  // чем бак наполнили в начале, а бензин закрывающей заправки поедет в
  // следующий перегон.
  fuelType: string | null
  station: string | null
  stationName: string | null
}

// Упор шкалы, а не полный бак: последние литры датчик уже не видит, поэтому сто
// процентов — это «столько, сколько он способен показать», и два таких конца
// сравнимы между собой.
export function isFullTank(refuel: Pick<TankRefuel, 'fuelAfter' | 'percentAfter'>) {
  if (refuel.percentAfter != null) return refuel.percentAfter >= 100
  if (refuel.fuelAfter == null) return false
  return refuel.fuelAfter >= FUEL_TANK_CAPACITY_LITRES - FUEL_SENSOR_STEP_LITRES
}

function endSlack(full: boolean) {
  return full ? FULL_TANK_SLACK_LITRES : SENSOR_LEVEL_SLACK_LITRES
}

function quadrature(values: number[]) {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
}

// Расход от заправки до заправки — единственное измерение, в котором датчик не
// участвует главным числом. Между двумя полными баками через двигатель прошло
// ровно столько, сколько долили во второй раз: это написано в чеке, и никакая
// нелинейность поплавка к нему не примешивается.
//
// Формула общая и для неполных баков тоже:
//
//   сожжено = долито + (уровень после прошлой заправки − уровень после этой)
//
// Скобка — поправка на то, что баки залиты по-разному. Когда оба полные, оба
// показания упираются в одну и ту же сотню, скобка обнуляется, и остаются чистые
// литры из чека, делённые на километры одометра.
export function tankLegs(refuels: TankRefuel[]): TankLeg[] {
  const sorted = [...refuels].sort((left, right) => left.detectedAt.getTime() - right.detectedAt.getTime())
  const legs: TankLeg[] = []

  for (let index = 1; index < sorted.length; index++) {
    const from = sorted[index - 1]!
    const to = sorted[index]!
    if (from.mileage == null || to.mileage == null) continue
    if (from.fuelAfter == null || to.fuelAfter == null) continue
    if (to.litresAdded == null) continue

    const distance = to.mileage - from.mileage
    if (!(distance > 0)) continue

    const litres = to.litresAdded + (from.fuelAfter - to.fuelAfter)
    // Отрицательные литры означают, что уровень после второй заправки выше, чем
    // прошлый плюс залитое: где-то соврал датчик, а не двигатель.
    if (!(litres > 0)) continue

    const fromFull = isFullTank(from)
    const toFull = isFullTank(to)
    const full = fromFull && toFull
    const litresError = quadrature([endSlack(fromFull), endSlack(toFull)])
    const distanceError = ODOMETER_REPORT_STEP_KM * UNIFORM_SIGMA * Math.sqrt(2)
    const consumption = litres / distance * 100
    const errorBound = consumption * quadrature([litresError / litres, distanceError / distance])

    const doubts: TankLegDoubt[] = []
    if (!full) doubts.push('partial')
    if (!to.confirmed) doubts.push('estimated')
    if (errorBound > consumption * MAX_ERROR_SHARE) doubts.push('short')

    legs.push({
      fromId: from.id,
      toId: to.id,
      from: from.detectedAt,
      to: to.detectedAt,
      fromMileage: from.mileage,
      toMileage: to.mileage,
      distance,
      litres,
      consumption,
      litresError,
      distanceError,
      errorBound,
      full,
      confirmed: to.confirmed,
      doubts,
      fuelType: from.fuelType,
      station: from.station,
      stationName: from.stationName
    })
  }

  return legs
}

export interface TankSummary {
  legs: number
  fullLegs: number
  distance: number
  litres: number
  consumption: number | null
  errorBound: number | null
  from: Date | null
  to: Date | null
  // Какую долю пробега окна перегоны вообще накрыли. Без неё «9,4 л/100 км»
  // читается как весь месяц, хотя до первой заправки могла быть неучтённая
  // треть.
  coverage: number | null
}

export interface TankWindow {
  // Показания одометра на краях окна. Ими перегон, перевалившийся через границу
  // месяца, делится между месяцами: расход внутри одного бака считается ровным,
  // и ничего лучше в данных всё равно нет.
  startMileage: number | null
  endMileage: number | null
}

const EMPTY_SUMMARY: TankSummary = {
  legs: 0,
  fullLegs: 0,
  distance: 0,
  litres: 0,
  consumption: null,
  errorBound: null,
  from: null,
  to: null,
  coverage: null
}

// Доля перегона, попавшая в окно, — по одометру, а не по времени: бак, залитый в
// пятницу, к понедельнику может быть сожжён целиком или не тронут вовсе.
function overlap(leg: TankLeg, window: TankWindow | undefined) {
  if (!window) return 1
  const covered = Math.min(leg.toMileage, window.endMileage!) - Math.max(leg.fromMileage, window.startMileage!)
  if (!(covered > 0)) return 0
  return Math.min(1, covered / leg.distance)
}

// Окно без одометра на краю — это не «всё, что есть», а «неизвестно что»: месяц,
// в котором ни один снимок не принёс пробега, нечем отрезать от соседних, и
// отдать за него всю историю было бы хуже, чем не отдать ничего.
function isWindowKnown(window: TankWindow | undefined) {
  return !window || (window.startMileage != null && window.endMileage != null)
}

function windowCoverage(distance: number, window?: TankWindow) {
  if (!window || window.startMileage == null || window.endMileage == null) return null
  const span = window.endMileage - window.startMileage
  if (!(span > 0)) return null
  return Math.min(1, distance / span)
}

// Сумма перегонов. Ошибка складывается в квадратуре и выходит с запасом: у
// соседних перегонов общий конец, и его промах входит в оба с разными знаками,
// то есть на деле сокращается. Считать это сокращение незачем — итоговая
// граница и так выходит вдесятеро меньше разброса между самими перегонами.
export function summariseTankLegs(legs: TankLeg[], window?: TankWindow): TankSummary {
  if (!isWindowKnown(window)) return { ...EMPTY_SUMMARY }
  let distance = 0
  let litres = 0
  let used = 0
  let fullLegs = 0
  const litresErrors: number[] = []
  const distanceErrors: number[] = []
  let from: Date | null = null
  let to: Date | null = null

  for (const leg of legs) {
    const share = overlap(leg, window)
    if (!(share > 0)) continue
    used++
    if (leg.full) fullLegs++
    distance += leg.distance * share
    litres += leg.litres * share
    litresErrors.push(leg.litresError * share)
    distanceErrors.push(leg.distanceError * share)
    if (!from || leg.from < from) from = leg.from
    if (!to || leg.to > to) to = leg.to
  }

  if (!used || !(distance > 0) || !(litres > 0)) {
    return { ...EMPTY_SUMMARY, coverage: windowCoverage(0, window) }
  }

  const consumption = litres / distance * 100
  const errorBound = consumption * quadrature([
    quadrature(litresErrors) / litres,
    quadrature(distanceErrors) / distance
  ])

  return {
    legs: used,
    fullLegs,
    distance,
    litres,
    consumption,
    errorBound,
    from,
    to,
    coverage: windowCoverage(distance, window)
  }
}

// Ниже этой доли пробега перегоны описывают уже не месяц, а его кусок, и старый
// расчёт по баку — при всей своей грубости — говорит хотя бы про весь месяц.
export const MIN_WINDOW_COVERAGE = 0.5

export function isTankSummaryUsable(summary: TankSummary) {
  return summary.consumption != null
    && summary.consumption > 0
    && (summary.coverage == null || summary.coverage >= MIN_WINDOW_COVERAGE)
}
