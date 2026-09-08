<script setup lang="ts">
import { MONTHLY_METRICS, monthlyMetric, type MonthlyMetricValue } from '~~/shared/monthly-metrics'
import { currentMoscowMonth, monthTitle as formatMonthTitle, moscowMonthRange, shiftMonth } from '~~/shared/moscow-month'
import { operatingDeviation } from '~~/shared/operating'
import { plural } from '~~/shared/plural'
import { STATIONS } from '~~/shared/stations'
import { WEEKDAYS } from '~~/shared/usage-profile'

const route = useRoute()

const month = computed(() => moscowMonthRange(route.query.month)?.month || currentMoscowMonth())
const { data, status } = await useFetch('/api/statistics', { query: computed(() => ({ month: month.value })) })
const chartMode = ref<'daily' | 'odometer'>('daily')
const chartModes = [
  { value: 'daily', label: 'По дням' },
  { value: 'odometer', label: 'Одометр' }
] as const
const canGoNext = computed(() => month.value < (data.value?.currentMonth || currentMoscowMonth()))
const hasData = computed(() => Boolean(data.value?.daily.some(item => item.distance > 0 || item.fuelUsed > 0)))
const hasOdometerData = computed(() => (data.value?.odometer.length || 0) > 1)
const odometerStart = computed(() => data.value?.odometer[0]?.mileage)
const odometerEnd = computed(() => data.value?.odometer.at(-1)?.mileage)
const odometerDistance = computed(() => {
  if (odometerStart.value == null || odometerEnd.value == null) return null
  return Math.max(0, odometerEnd.value - odometerStart.value)
})

const monthTitle = computed(() => formatMonthTitle(month.value))

// Помесячные графики живут отдельным запросом: окно у них своё — вся история до
// текущего месяца, — поэтому переключение месяцев их не перезагружает.
const { data: monthly } = await useFetch('/api/statistics/monthly')
// Тем же окном живут зависимости и тренды: темп цены, сезонность, напряжение
// перед пуском. Месяц для них — одна точка, и переключать их вместе с месяцем
// было бы нечем.
const { data: insights } = await useFetch('/api/statistics/insights')
const trendMetric = ref<MonthlyMetricValue>('distance')
const trendOptions = MONTHLY_METRICS.map(item => ({ value: item.value, label: item.label }))
const trend = computed(() => monthlyMetric(trendMetric.value))
const monthlyRows = computed(() => monthly.value?.months || [])
// Один месяц — это не график, а то же самое число, что и на карточках выше.
const hasMonthlyData = computed(() => monthlyRows.value.length > 1)

function number(value: number | null | undefined, digits = 1) {
  return value == null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value)
}

// The balance counts warm-ups and short hops the trip log cannot see, so it
// reads higher than the sum of the bars below it. Spelling the arithmetic out
// is what keeps that difference from looking like an error.
const fuelExplanation = computed(() => {
  const totals = data.value?.totals
  if (!totals || totals.fuelSource !== 'balance') return 'По данным завершённых поездок'
  return `В баке ${number(totals.tankStart)} → ${number(totals.tankEnd)} л, заправлено ${number(totals.refuelled)} л`
})

function money(value: number | null | undefined, digits = 2) {
  if (value == null) return '—'
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: digits }).format(value)
}
function celsius(value: number | null | undefined) {
  return value == null ? '—' : `${number(value, 0)} °C`
}
function duration(minutes: number | null | undefined) {
  if (!minutes) return '0 мин'
  const rounded = Math.round(minutes)
  const hours = Math.floor(rounded / 60)
  const rest = rounded % 60
  return hours ? `${hours} ч ${rest} мин` : `${rest} мин`
}

function trendValue(row: { [key in MonthlyMetricValue]?: number | null } | null | undefined) {
  const value = row?.[trend.value.value]
  if (value == null) return '—'
  if (trend.value.money) return money(value, trend.value.digits)
  return trend.value.unit ? `${number(value, trend.value.digits)} ${trend.value.unit}` : number(value, trend.value.digits)
}

// Соседние месяцы — единственное сравнение, которое график не показывает сам:
// глазом по столбцам видно направление, но не то, на сколько процентов.
const trendComparison = computed(() => {
  const rows = monthlyRows.value
  const selected = rows.findIndex(row => row.month === month.value)
  const index = selected >= 0 ? selected : rows.length - 1
  const current = rows[index]
  const previous = rows[index - 1]
  if (!current || !previous) return null
  const now = current[trend.value.value]
  const before = previous[trend.value.value]
  return { current, previous, share: now != null && before != null && before > 0 ? now / before - 1 : null }
})

// Клик по столбцу — переход к тому месяцу: график и карточки над ним смотрят на
// одно и то же, и возвращаться ради этого к стрелкам вверху незачем.
function goToMonth(value: string) {
  if (value !== month.value) navigateTo({ query: { month: value } })
}

// Рубли за бензин — это чеки, а не бак: заправка без суммы в итог не попадает,
// и сколько их было, сказано рядом, иначе сумма выглядит просто заниженной.
const fuelSpendNote = computed(() => {
  const spend = data.value?.fuelSpend
  if (!spend || !spend.total) return 'За этот месяц заправок не было'
  if (!spend.refuels) return `Ни у одной из ${number(spend.total, 0)} ${plural(spend.total, 'заправки', 'заправок', 'заправок')} нет чека`
  const parts = [`${number(spend.refuels, 0)} ${plural(spend.refuels, 'заправка', 'заправки', 'заправок')} с чеком`]
  if (spend.pricePerLitre != null) parts.push(`${money(spend.pricePerLitre)}/л`)
  if (spend.unknown > 0) parts.push(`у ${number(spend.unknown, 0)} нет суммы`)
  return parts.join(' · ')
})

// Полнота учёта: какая доля залитых литров подтверждена чеком. Пока она не
// близка к единице, сумма затрат — это не «сколько ушло на бензин», а «сколько
// из этого удалось увидеть».
const coverageNote = computed(() => {
  const coverage = data.value?.coverage
  if (!coverage?.refuels) return null
  if (coverage.share == null) return null
  if (coverage.missing === 0) return 'Чеки есть у всех заправок месяца'
  const parts = [`Чеками закрыто ${number(coverage.share * 100, 0)}% залитых литров`]
  if (coverage.missingAmount != null) parts.push(`без чека осталось примерно на ${money(coverage.missingAmount, 0)}`)
  return parts.join(' · ')
})

// Стояние с заведённым двигателем в рублях — та часть топливного бюджета,
// которая не увезла машину никуда.
const idleShare = computed(() => {
  const idle = data.value?.idle
  const spent = data.value?.fuelSpend.amount
  if (!idle?.cost || !spent) return null
  return idle.cost / spent
})

const cold = computed(() => data.value?.coldStarts)

const starts = computed(() => insights.value?.starts)
const warmup = computed(() => insights.value?.warmup)
const inflation = computed(() => insights.value?.inflation.main)
const overpay = computed(() => insights.value?.overpay)
const seasonality = computed(() => insights.value?.seasonality)
const yearAhead = computed(() => insights.value?.year)
const yearComparison = computed(() => insights.value?.comparison)
const records = computed(() => insights.value?.records)
const recordRows = computed(() => {
  const found = records.value
  if (!found?.busiest) return []
  return [
    { label: 'Больше всего километров', record: found.busiest, format: (value: number) => `${number(value, 0)} км` },
    { label: 'Меньше всего километров', record: found.quietest, format: (value: number) => `${number(value, 0)} км` },
    { label: 'Самый экономичный', record: found.thriftiest, format: (value: number) => `${number(value)} л/100 км` },
    { label: 'Самый прожорливый', record: found.thirstiest, format: (value: number) => `${number(value)} л/100 км` },
    { label: 'Самый дешёвый километр', record: found.cheapestKm, format: (value: number) => money(value) },
    { label: 'Самый дорогой километр', record: found.dearestKm, format: (value: number) => money(value) }
  ].filter(row => row.record)
})

// Сети, у которых переплата вообще набралась: строка «Роснефть — 0 ₽» говорит
// лишь о том, что она и была самой дешёвой, и в списке переплат ей нечего
// делать.
const overpayStations = computed(() => (overpay.value?.byStation || []).filter(item => item.amount > 0))

// Имя сети берётся из чека, а если его там нет — из общего списка: в базе у
// заправки лежит код вроде `lukoil`, и показывать код на странице незачем.
function stationLabel(station: string | null, name: string | null) {
  return name || STATIONS.find(item => item.value === station)?.label || 'Другая АЗС'
}

function percent(value: number | null | undefined, digits = 0) {
  if (value == null) return '—'
  return `${value > 0 ? '+' : '−'}${number(Math.abs(value) * 100, digits)}%`
}

// Знак ставится по самому числу, а не жёстким плюсом в шаблоне: наклон может
// оказаться и обратным, и тогда «+-0,9» — это не подпись, а опечатка.
function signed(value: number | null | undefined, unit: string, digits = 1) {
  if (value == null) return '—'
  return `${value >= 0 ? '+' : '−'}${number(Math.abs(value), digits)} ${unit}`
}

const driverRows = computed(() => data.value?.byDriver || [])
// Пока на вопрос бота ни разу не ответили, разбивка состоит из одной строки
// «Не указан» — это не сравнение водителей, а сообщение, что данных нет.
const hasDrivers = computed(() => driverRows.value.some(row => row.driver))

const speedRows = computed(() => (data.value?.bySpeed || []).filter(item => item.trips > 0))
// A bar chart of consumption needs a ceiling, and the jam bucket is always the
// ceiling: idling burns fuel and covers no ground.
const worstConsumption = computed(() => Math.max(1, ...speedRows.value.map(item => item.consumption || 0)))
function speedRange(item: { name: string, upTo: number }, index: number) {
  const from = index === 0 ? 0 : speedRows.value[index - 1]!.upTo
  return Number.isFinite(item.upTo) ? `${from}–${item.upTo} км/ч` : `от ${from} км/ч`
}
type SpeedRow = { consumption: number | null, consumptionUncertainty: number | null }
function extreme(pick: (candidate: number, current: number) => boolean) {
  return computed(() => speedRows.value.reduce<SpeedRow | null>((found, item) => {
    if (item.consumption == null) return found
    if (found?.consumption == null || pick(item.consumption, found.consumption)) return item
    return found
  }, null))
}
const cheapest = extreme((candidate, current) => candidate < current)
const dearest = extreme((candidate, current) => candidate > current)
// Обе корзины измерены с точностью до округления датчика, и на трёх поездках
// интервал легко перекрывает саму разницу. Пока разрыв не больше сложенных
// погрешностей, это не «дороже», а шум, и объявлять его нечестно.
const speedSpread = computed(() => {
  const low = cheapest.value?.consumption
  const high = dearest.value?.consumption
  if (low == null || high == null || low <= 0) return null
  const error = (cheapest.value?.consumptionUncertainty || 0) + (dearest.value?.consumptionUncertainty || 0)
  if (high - low <= error) return null
  const ratio = high / low
  return ratio >= 1.2 ? ratio : null
})

// Недели без часа работы двигателя не показываются: делить километры на десять
// минут — это не режим эксплуатации, а случайность округления счётчика.
const operatingWeeks = computed(() => (data.value?.operating.periods || []).filter(item => item.kmPerHour != null))
const bestOperating = computed(() => Math.max(1, ...operatingWeeks.value.map(item => item.kmPerHour || 0)))
function weekTitle(week: { from: string, to: string }) {
  const format = (value: string, withMonth: boolean) => new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    ...(withMonth ? { month: 'short' } : {})
  }).format(new Date(`${value}T00:00:00+03:00`))
  return week.from === week.to ? format(week.from, true) : `${format(week.from, false)}–${format(week.to, true)}`
}
// Самая слабая неделя месяца — и только если она действительно выбилась.
// Порог в четверть взят затем, чтобы подпись не появлялась на ровном месяце,
// где недели отличаются на несколько процентов и объяснять нечего.
const weakestWeek = computed(() => {
  const weeks = operatingWeeks.value
  if (weeks.length < 3) return null
  const worst = weeks.reduce((found, item) => item.kmPerHour! < found.kmPerHour! ? item : found)
  const deviation = operatingDeviation(weeks, worst)
  return deviation != null && deviation <= -0.25 ? { week: worst, deviation } : null
})

// Названия постоянных расходов, вошедших в этот месяц. Без них «1019 ₽» выглядит
// взявшимся ниоткуда, а с ними понятно, что это полис и налог.
const fixedCostLabels = computed(() => {
  const items = (data.value?.ownership.fixed || []).filter(item => item.share > 0)
  if (!items.length) return 'Постоянные расходы'
  return items.slice(0, 3).map(item => item.label).join(', ') + (items.length > 3 ? ' и ещё' : '')
})

const usage = computed(() => data.value?.usage)
// Показываются только те часы, в которые машина хоть раз выезжала. Все двадцать
// четыре столбца отдали бы половину ширины ночи, где не бывает ничего: за август
// ни одной поездки раньше шести и позже восемнадцати.
const usageHours = computed(() => {
  const profile = usage.value
  if (!profile || profile.fromHour == null || profile.toHour == null) return []
  return Array.from({ length: profile.toHour - profile.fromHour + 1 }, (_, index) => profile.fromHour! + index)
})
const usageGrid = computed(() => {
  const profile = usage.value
  if (!profile) return []
  const byKey = new Map(profile.cells.map(cell => [`${cell.weekday}:${cell.hour}`, cell]))
  return WEEKDAYS.map((label, weekday) => ({
    weekday,
    label,
    cells: usageHours.value.map(hour => byKey.get(`${weekday}:${hour}`) ?? { weekday, hour, trips: 0, distance: 0 })
  }))
})
const hottestCell = computed(() => Math.max(0, ...(usage.value?.cells || []).map(cell => cell.distance)))
const busiestWeekdayLabel = computed(() => {
  const index = usage.value?.busiestWeekday
  return index == null ? null : WEEKDAYS[index]
})
function hours(value: number | null | undefined) {
  if (value == null) return '—'
  if (value < 24) return `${number(value, 0)} ч`
  return `${number(value / 24, 1)} сут`
}

function date(value: string | Date) {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
// Ссылка ведёт в журнал за тот день, которому поездка принадлежит по Москве, —
// журнал фильтрует ровно так же.
function moscowDay(value: string | Date) {
  return new Date(new Date(value).getTime() + 3 * 60 * 60_000).toISOString().slice(0, 10)
}

useHead({ title: computed(() => `Статистика — ${monthTitle.value} — StarLine Pulse`) })
</script>

<template>
  <div>
    <header class="page-heading history-heading">
      <div><p class="eyebrow">Автомобиль</p><h1 class="page-title">Статистика</h1></div>
      <nav class="month-switcher" aria-label="Выбор месяца">
        <AppIconButton
          class="month-switcher__arrow"
          label="Предыдущий месяц"
          title="Предыдущий месяц"
          :to="{ query: { month: shiftMonth(month, -1) } }"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
        </AppIconButton>
        <strong>{{ monthTitle }}</strong>
        <AppIconButton
          class="month-switcher__arrow"
          label="Следующий месяц"
          title="Следующий месяц"
          :to="canGoNext ? { query: { month: shiftMonth(month, 1) } } : undefined"
          :inactive="!canGoNext"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
        </AppIconButton>
      </nav>
    </header>

    <div v-if="status === 'pending'" class="card card--wide skeleton">Загрузка истории…</div>
    <div v-else class="grid history-grid">
      <section class="card metric-card history-metric">
        <div class="card__top"><p class="metric-label">Пробег за месяц</p></div>
        <p class="metric">{{ number(data?.totals.distance) }} <small>км</small></p>
        <p class="metric-meta">{{ number(data?.totals.trips, 0) }} поездок</p>
      </section>
      <section class="card metric-card history-metric">
        <div class="card__top"><p class="metric-label">Израсходовано</p></div>
        <p class="metric">{{ number(data?.totals.fuelUsed) }} <small>л</small></p>
        <p class="metric-meta">{{ fuelExplanation }}</p>
      </section>
      <section class="card metric-card history-metric">
        <div class="card__top"><p class="metric-label">Средний расход</p></div>
        <p class="metric">{{ number(data?.totals.consumption) }} <small>л/100 км</small></p>
        <p class="metric-meta">
          <span v-if="data?.ambient.average != null">Ночью за месяц {{ celsius(data.ambient.average) }} · от {{ celsius(data.ambient.min) }} до {{ celsius(data.ambient.max) }}</span>
          <span v-else>За выбранный месяц</span>
        </p>
      </section>
      <section class="card metric-card history-metric">
        <div class="card__top"><p class="metric-label">Затраты на бензин</p></div>
        <p class="metric metric--compact">{{ money(data?.fuelSpend.amount, 0) }}</p>
        <p class="metric-meta">{{ fuelSpendNote }}</p>
        <p v-if="coverageNote" class="metric-meta">{{ coverageNote }}</p>
      </section>

      <section class="card metric-card history-metric">
        <div class="card__top"><p class="metric-label">Стояли заведёнными</p></div>
        <p class="metric metric--compact">{{ money(data?.idle.cost, 0) }}</p>
        <p class="metric-meta">
          <template v-if="data?.idle.minutes">
            {{ duration(data.idle.minutes) }} работы двигателя без единого километра · {{ number(data.idle.litres) }} л
            <template v-if="idleShare"> · это {{ number(idleShare * 100, 0) }}% всех денег на бензин</template>
          </template>
          <template v-else>За этот месяц машина заведённой не стояла</template>
        </p>
      </section>

      <section class="card metric-card history-metric">
        <div class="card__top"><p class="metric-label">Холодные пуски</p></div>
        <p class="metric">{{ number(cold?.cold, 0) }} <small>раз</small></p>
        <p class="metric-meta">
          <template v-if="cold?.per1000Km != null">
            {{ number(cold.per1000Km, 1) }} на тысячу километров — именно они изнашивают двигатель, а не пробег
            <template v-if="cold.neverWarm">
              · в {{ number(cold.neverWarm, 0) }} {{ plural(cold.neverWarm, 'поездке', 'поездках', 'поездках') }}
              двигатель так и не прогрелся
            </template>
          </template>
          <template v-else>За этот месяц двигатель не заводили</template>
        </p>
      </section>
      <section class="card metric-card history-metric">
        <div class="card__top"><p class="metric-label">Километр стоит</p></div>
        <p class="metric">{{ money(data?.ownership.variablePerKm ?? data?.totals.costPerKm) }}</p>
        <p class="metric-meta">
          <span v-if="data?.ownership.servicePerKm != null">
            Топливо {{ money(data.ownership.fuelPerKm) }} + обслуживание {{ money(data.ownership.servicePerKm) }}
          </span>
          <span v-else-if="data?.totals.pricePerLitre != null">Топливо по {{ money(data.totals.pricePerLitre) }}/л · {{ number(data.totals.fuelUsed) }} л на {{ number(data.totals.distance) }} км</span>
          <span v-else>Нет чеков — цена литра неизвестна</span>
        </p>
      </section>

      <section class="card metric-card history-metric">
        <div class="card__top"><p class="metric-label">С учётом владения</p></div>
        <p class="metric">{{ money(data?.ownership.totalPerKm) }}</p>
        <p class="metric-meta">
          <span v-if="data?.ownership.fixedPerKm != null">
            {{ fixedCostLabels }} — {{ money(data.ownership.fixedAmount, 0) }} за месяц, это {{ money(data.ownership.fixedPerKm) }} на километр
          </span>
          <span v-else>Постоянные расходы не заведены — добавить можно на странице обслуживания</span>
        </p>
      </section>

      <section class="card metric-card history-metric">
        <div class="card__top"><p class="metric-label">Километры на моточас</p></div>
        <p class="metric">{{ number(data?.operating.total.kmPerHour) }} <small>км/ч работы</small></p>
        <p class="metric-meta">
          <span v-if="data?.operating.total.band">
            {{ data.operating.total.band.label }} · двигатель работал {{ number(data.operating.total.motorHours) }} ч
          </span>
          <span v-else>Двигатель работал меньше часа</span>
        </p>
      </section>

      <section class="card card--wide history-chart-card">
        <div class="card__top">
          <div>
            <p class="metric-label">{{ chartMode === 'daily' ? 'Пробег и топливо по дням' : 'Общий пробег за месяц' }}</p>
            <p v-if="chartMode === 'daily'" class="muted">Столбцы — километры, линия — литры по завершённым поездкам</p>
            <p v-else class="muted">
              Показания одометра: {{ number(odometerStart) }} → {{ number(odometerEnd) }} км
              <span v-if="odometerDistance != null"> · +{{ number(odometerDistance) }} км</span>
            </p>
          </div>
          <AppSegmented v-model="chartMode" :options="chartModes" label="Вид графика" tabs />
        </div>
        <HistoryChart
          v-if="data?.daily.length && (chartMode === 'daily' || hasOdometerData)"
          :items="data.daily"
          :mode="chartMode"
          :odometer="data.odometer"
        />
        <p v-if="chartMode === 'daily' && !hasData" class="muted history-empty">За этот месяц завершённых поездок пока нет.</p>
        <p v-if="chartMode === 'odometer' && !hasOdometerData" class="muted history-empty">За этот месяц недостаточно показаний одометра.</p>
      </section>

      <section class="card card--wide history-chart-card monthly-card">
        <div class="card__top">
          <div>
            <p class="metric-label">{{ trend.title }}</p>
            <p class="muted">{{ trend.hint }}</p>
          </div>
          <AppSegmented v-model="trendMetric" :options="trendOptions" label="Параметр помесячно" tabs />
        </div>
        <MonthlyChart
          v-if="hasMonthlyData"
          :items="monthlyRows"
          :metric="trend"
          :selected="month"
          @select="goToMonth"
        />
        <p v-if="!hasMonthlyData" class="muted history-empty">Помесячный график появится, когда наберётся второй месяц наблюдений.</p>
        <p v-else-if="trendComparison" class="metric-meta">
          {{ formatMonthTitle(trendComparison.current.month) }} против предыдущего месяца:
          {{ trendValue(trendComparison.previous) }} → {{ trendValue(trendComparison.current) }}
          <template v-if="trendComparison.share != null">
            · {{ trendComparison.share > 0 ? '+' : '−' }}{{ number(Math.abs(trendComparison.share) * 100, 0) }}%
          </template>
          <template v-if="trendComparison.current.month === data?.currentMonth">
            · месяц ещё не кончился, и сравнивать его с полным можно только с поправкой на это
          </template>
        </p>
      </section>

      <section class="card card--wide">
        <div class="card__top">
          <div>
            <p class="metric-label">Год целиком</p>
            <p class="muted">
              Сколько уже проехано с начала наблюдений этого года, к чему год придёт к декабрю при нынешней езде
              и чем он отличается от прошлого — по одним и тем же месяцам, а не по календарю
            </p>
          </div>
        </div>
        <p v-if="!yearAhead" class="muted empty-note">Год ещё не начался — данных за него нет.</p>
        <template v-else>
          <div class="pace-list">
            <p class="pace-row">
              <span>Проехано с начала года</span>
              <strong>{{ number(yearAhead.distance, 0) }} км за {{ number(yearAhead.daysGone, 0) }} дней</strong>
            </p>
            <p class="pace-row">
              <span>Выходит в среднем</span>
              <strong>{{ number(yearAhead.perDay) }} км в сутки</strong>
            </p>
            <p class="pace-row">
              <span>К концу года при такой езде</span>
              <strong>
                {{ number(yearAhead.projectedDistance, 0) }} км
                <template v-if="yearAhead.projectedSpend != null"> · {{ money(yearAhead.projectedSpend, 0) }} на бензин</template>
              </strong>
            </p>
            <p v-if="yearComparison" class="pace-row">
              <span>Те же {{ number(yearComparison.months, 0) }} {{ plural(yearComparison.months, 'месяц', 'месяца', 'месяцев') }} год назад</span>
              <strong>
                {{ number(yearComparison.previousDistance, 0) }} км
                <template v-if="yearComparison.distanceShare != null"> · {{ percent(yearComparison.distanceShare) }}</template>
              </strong>
            </p>
          </div>
          <p v-if="!yearComparison" class="metric-meta">
            Сравнить с прошлым годом пока не с чем: тех же месяцев год назад в данных ещё нет. Прогноз на декабрь —
            простой перенос среднего дня на остаток года, сезонности он не знает.
          </p>
          <template v-if="recordRows.length">
            <p class="pace-caption">Рекорды по законченным месяцам</p>
            <div class="pace-list">
              <p v-for="row in recordRows" :key="row.label" class="pace-row">
                <span>{{ row.label }}</span>
                <strong>{{ formatMonthTitle(row.record!.month) }} — {{ row.format(row.record!.value) }}</strong>
              </p>
            </div>
          </template>
        </template>
      </section>

      <section class="card card--wide">
        <div class="card__top">
          <div>
            <p class="metric-label">Что происходит с ценой литра</p>
            <p class="muted">
              Своя инфляция — по собственным чекам, а не по объявленной. Рядом переплата: во что обошлось то,
              что заправлялись не у самой дешёвой из сетей, куда машина и так заезжает
            </p>
          </div>
        </div>
        <p v-if="!inflation" class="muted empty-note">Чеков с ценой пока нет — считать нечего.</p>
        <template v-else>
          <div class="pace-list">
            <p class="pace-row">
              <span>{{ inflation.fuelType }} сейчас</span>
              <strong>{{ money(inflation.last.price) }}/л · {{ formatMonthTitle(inflation.last.month) }}</strong>
            </p>
            <p class="pace-row">
              <span>Первый чек в истории</span>
              <strong>{{ money(inflation.first.price) }}/л · {{ formatMonthTitle(inflation.first.month) }}</strong>
            </p>
            <p v-if="inflation.monthlyRate != null" class="pace-row">
              <span>Темп подорожания</span>
              <strong>
                {{ percent(inflation.monthlyRate, 1) }} в месяц
                <template v-if="inflation.yearlyRate != null"> · {{ percent(inflation.yearlyRate) }} за год такими темпами</template>
              </strong>
            </p>
            <p v-if="inflation.yearOverYear" class="pace-row">
              <span>Год назад, {{ formatMonthTitle(inflation.yearOverYear.previousMonth).toLowerCase() }}</span>
              <strong>
                {{ money(inflation.yearOverYear.previousPrice) }}/л · {{ percent(inflation.yearOverYear.share, 1) }}
              </strong>
            </p>
            <p v-for="item in inflation.forecast" :key="item.month" class="pace-row">
              <span>{{ formatMonthTitle(item.month) }}, если темп сохранится</span>
              <strong>{{ money(item.price) }}/л</strong>
            </p>
          </div>
          <p v-if="inflation.monthlyRate == null" class="metric-meta">
            Направления в цене пока не видно: {{ number(inflation.fills, 0) }}
            {{ plural(inflation.fills, 'чек', 'чека', 'чеков') }} за
            {{ number(inflation.days, 0) }} {{ plural(Math.round(inflation.days), 'день', 'дня', 'дней') }} —
            это разброс, а не подорожание, и называть по нему темп было бы выдумкой.
          </p>
        </template>
        <template v-if="overpay && overpay.fills">
          <p class="pace-caption">Переплата за выбор заправки</p>
          <div class="pace-list">
            <p class="pace-row">
              <span>Всего с начала наблюдений</span>
              <strong>
                {{ money(overpay.amount, 0) }}
                <template v-if="overpay.share != null"> · {{ number(overpay.share * 100, 1) }}% от потраченного</template>
              </strong>
            </p>
            <p v-for="item in overpayStations" :key="item.station || 'other'" class="pace-row">
              <span>{{ stationLabel(item.station, item.stationName) }}</span>
              <strong>{{ money(item.amount, 0) }} за {{ number(item.litres, 0) }} л</strong>
            </p>
          </div>
          <p class="metric-meta">
            Каждая заправка сравнивается с ценой самой дешёвой сети, известной на её собственный день, — сравнение
            со средней за всё время мерило бы инфляцию, а не выбор.
            <template v-if="overpay.skipped">
              Ещё {{ number(overpay.skipped, 0) }}
              {{ plural(overpay.skipped, 'заправке', 'заправкам', 'заправкам') }} сравнивать было не с чем: другой сети
              с этим топливом на тот день не знали.
            </template>
          </p>
        </template>
      </section>

      <section class="card card--wide">
        <div class="card__top">
          <div>
            <p class="metric-label">Во что обходится холод</p>
            <p class="muted">
              Расход месяца против его ночной температуры. Сравнивать месяцы напрямую нельзя — холодный месяц обычно
              и ездит иначе, — поэтому считается наклон: сколько литров на сотню добавляет каждый градус
            </p>
          </div>
        </div>
        <p v-if="!seasonality || !seasonality.months" class="muted empty-note">
          Нужен хотя бы месяц с расходом и ночными температурами.
        </p>
        <template v-else-if="seasonality.litresPerTenDegrees != null">
          <div class="pace-list">
            <p class="pace-row">
              <span>Каждые десять градусов холода</span>
              <strong>{{ signed(seasonality.litresPerTenDegrees, 'л/100 км') }}</strong>
            </p>
            <p v-for="item in seasonality.premium" :key="item.month" class="pace-row">
              <span>{{ formatMonthTitle(item.month) }} — {{ celsius(item.celsius) }}</span>
              <strong>
                +{{ number(item.extraLitres) }} л
                <template v-if="item.extraCost != null"> · {{ money(item.extraCost, 0) }}</template>
              </strong>
            </p>
          </div>
          <p class="metric-meta">
            Всего холод добавил {{ number(seasonality.extraLitres) }} л
            <template v-if="seasonality.extraCost != null"> и {{ money(seasonality.extraCost, 0) }}</template>
            <template v-if="seasonality.share != null"> — это {{ number(seasonality.share * 100, 0) }}% всего израсходованного</template>.
            Отсчёт идёт от {{ celsius(15) }}: месяц теплее этого надбавки не получает.
          </p>
        </template>
        <p v-else class="metric-meta">
          Пока месяцы отличаются друг от друга чем угодно, кроме холода: {{ number(seasonality.months, 0) }}
          {{ plural(seasonality.months, 'месяц', 'месяца', 'месяцев') }} наблюдений от {{ celsius(seasonality.coldest) }}
          до {{ celsius(seasonality.warmest) }} — этого мало, чтобы отделить погоду от того, как ездили.
        </p>
      </section>

      <section class="card card--wide">
        <div class="card__top">
          <div>
            <p class="metric-label">Сколько греется двигатель</p>
            <p class="muted">
              Термометра на улицу в машине нет — есть двигатель, простоявший ночь: к утру он принимает температуру
              воздуха. По таким пускам и видно, на сколько холод удлиняет прогрев
            </p>
          </div>
        </div>
        <p v-if="!warmup || !warmup.samples" class="muted empty-note">
          Пусков после долгой стоянки, по которым можно судить о прогреве, пока нет.
        </p>
        <template v-else>
          <div class="pace-list">
            <p class="pace-row">
              <span>Обычный прогрев</span>
              <strong>{{ duration(warmup.medianMinutes) }} по {{ number(warmup.samples, 0) }} пускам</strong>
            </p>
            <p v-if="warmup.minutesPerTenDegrees != null" class="pace-row">
              <span>Каждые десять градусов холода</span>
              <strong>{{ signed(warmup.minutesPerTenDegrees, 'мин') }}</strong>
            </p>
            <p v-for="item in warmup.forecast" :key="item.celsius" class="pace-row">
              <span>При {{ celsius(item.celsius) }}</span>
              <strong>
                {{ duration(item.minutes) }}
                <template v-if="item.litres != null"> · {{ number(item.litres) }} л</template>
                <template v-if="item.cost != null"> · {{ money(item.cost, 0) }}</template>
              </strong>
            </p>
          </div>
          <p class="metric-meta">
            <template v-if="warmup.minutesPerTenDegrees == null">
              Зависимости от погоды пока не видно: наблюдений от {{ celsius(warmup.coldest) }} до
              {{ celsius(warmup.warmest) }} слишком мало и слишком в узком диапазоне.
            </template>
            <template v-else>
              Прогноз даётся только для той погоды, которую машина уже видела: от {{ celsius(warmup.coldest) }} до
              {{ celsius(warmup.warmest) }}. Мороз живёт по своим законам, и продлевать в него осеннюю прямую нечестно.
            </template>
            Минуты считаются по одометру, а он рапортует кусками, поэтому само число слегка завышено — но одинаково для
            всех пусков, и на наклон это не влияет.
          </p>
        </template>
      </section>

      <section class="card card--wide">
        <div class="card__top">
          <div>
            <p class="metric-label">Чем заводится машина</p>
            <p class="muted">
              Времени прокрутки стартера в данных нет: журнал присылает «зажигание» и «двигатель запущен» с разницей
              в секунду. Зато видно напряжение перед пуском — именно оно предсказывает утро, когда машина не заведётся
            </p>
          </div>
        </div>
        <p v-if="!starts || !starts.starts" class="muted empty-note">Пусков в журнале сигнализации пока нет.</p>
        <template v-else>
          <div class="pace-list">
            <p class="pace-row">
              <span>Пусков всего</span>
              <strong>
                {{ number(starts.starts, 0) }} · из них {{ number(starts.remote, 0) }}
                {{ plural(starts.remote, 'автозапуск', 'автозапуска', 'автозапусков') }}
              </strong>
            </p>
            <p v-if="starts.voltage.average != null" class="pace-row">
              <span>Напряжение перед пуском</span>
              <strong>
                {{ number(starts.voltage.average, 2) }} В в среднем · ниже всего {{ number(starts.voltage.lowest, 2) }} В
              </strong>
            </p>
            <p v-if="starts.voltage.perMonth != null" class="pace-row">
              <span>Куда оно едет</span>
              <strong>{{ number(starts.voltage.perMonth, 2) }} В в месяц</strong>
            </p>
            <p v-if="starts.voltage.low" class="pace-row">
              <span>Пусков с просевшей батареей</span>
              <strong>
                {{ number(starts.voltage.low, 0) }} ниже 12,4 В
                <template v-if="starts.voltage.critical"> · {{ number(starts.voltage.critical, 0) }} ниже 12,0 В</template>
              </strong>
            </p>
          </div>
          <p class="metric-meta">
            <template v-if="starts.voltage.samples">
              Считается по {{ number(starts.voltage.samples, 0) }}
              {{ plural(starts.voltage.samples, 'пуску', 'пускам', 'пускам') }} после стоянки дольше шести часов: сразу
              после поездки на клеммах висит заряд от генератора, и те же 12,9 В не значат ничего.
            </template>
            <template v-else>
              Замеров перед пуском пока нет: опрос не заставал машину заглушенной незадолго до старта.
            </template>
            <template v-if="starts.voltage.perMonth == null && starts.voltage.samples > 2">
              Направления в напряжении не видно — на такой выборке это разброс, а не умирающая батарея.
            </template>
            <template v-if="starts.crank.samples">
              При автозапуске от «начал заводиться» до «запущен» проходит {{ number(starts.crank.seconds, 0) }} с,
              но это выдержка сигнализации, а не время прокрутки стартера.
            </template>
          </p>
        </template>
      </section>

      <section class="card card--wide">
        <div class="card__top">
          <div>
            <p class="metric-label">Как работал двигатель</p>
            <p class="muted">
              Километры за час работы двигателя по неделям. В знаменателе всё время, что мотор крутился, —
              прогревы и стояние тоже, поэтому число говорит не о скорости, а о том, сколько из работы двигателя досталось дороге
            </p>
          </div>
        </div>
        <p v-if="!operatingWeeks.length" class="muted empty-note">За этот месяц двигатель работал слишком мало, чтобы делить.</p>
        <div v-else class="speed-rows">
          <div v-for="week in operatingWeeks" :key="week.bucket" class="speed-row">
            <div class="speed-row__head">
              <strong>{{ weekTitle(week) }}</strong>
              <span class="muted">{{ week.band?.label }}</span>
            </div>
            <span class="speed-row__track"><span class="speed-row__bar" :style="{ width: `${(week.kmPerHour || 0) / bestOperating * 100}%` }" /></span>
            <p class="speed-row__value">
              <strong>{{ number(week.kmPerHour) }} км/ч работы</strong>
              <span class="muted">{{ number(week.km, 0) }} км · двигатель {{ number(week.motorHours) }} ч</span>
            </p>
          </div>
        </div>
        <p v-if="weakestWeek" class="metric-meta">
          {{ weekTitle(weakestWeek.week) }}: двигатель наработал столько же, а километров вышло на
          {{ number(Math.abs(weakestWeek.deviation) * 100, 0) }}% меньше обычного — эти часы машина простояла заведённой.
        </p>
      </section>

      <section class="card card--wide">
        <div class="card__top">
          <div>
            <p class="metric-label">За рулём</p>
            <p class="muted">Пробег и деньги по водителям — по тем поездкам, на которые ответили в боте, поэтому в сумме они меньше израсходованного за месяц</p>
          </div>
        </div>
        <p v-if="!hasDrivers" class="muted empty-note">За этот месяц никто не отметился за рулём.</p>
        <div v-else class="speed-rows">
          <div v-for="row in driverRows" :key="row.driver || 'unknown'" class="speed-row">
            <div class="speed-row__head">
              <strong :class="{ muted: !row.driver }">{{ row.driver || 'Не указан' }}</strong>
              <span class="muted">{{ number(row.share * 100, 0) }}% пробега</span>
            </div>
            <span class="speed-row__track"><span class="speed-row__bar" :style="{ width: `${row.share * 100}%` }" /></span>
            <p class="speed-row__value">
              <strong>
                {{ number(row.distance) }} км
                <template v-if="row.cost != null"> · {{ money(row.cost, 0) }}</template>
              </strong>
              <span class="muted">
                {{ number(row.trips, 0) }} поездок · {{ duration(row.minutes) }}
                <template v-if="row.consumption != null"> · {{ number(row.consumption) }} л/100 км</template>
              </span>
            </p>
          </div>
        </div>
        <p v-if="hasDrivers" class="metric-meta">
          Известен водитель у {{ number((data?.driverCoverage.share || 0) * 100, 0) }}% пробега
          ({{ number(data?.driverCoverage.answered, 0) }} из {{ number(data?.driverCoverage.trips, 0) }} поездок) —
          сравнивать имена между собой можно только внутри этой доли.
          Литры здесь — по завершённым поездкам, поэтому в сумме их меньше, чем израсходовано за месяц: прогревы за руль никто не сажал.
        </p>
      </section>

      <section class="card card--wide">
        <div class="card__top">
          <div>
            <p class="metric-label">Когда ездим</p>
            <p class="muted">Поездки по часам и дням недели: клетка тем темнее, чем больше в ней километров</p>
          </div>
        </div>
        <p v-if="!usage || !usage.trips" class="muted empty-note">За этот месяц завершённых поездок нет.</p>
        <template v-else>
          <div class="heatmap" :style="{ '--hours': usageHours.length }">
            <div class="heatmap__row heatmap__row--head">
              <span class="heatmap__day" />
              <span v-for="hour in usageHours" :key="hour" class="heatmap__hour">{{ hour }}</span>
            </div>
            <div v-for="row in usageGrid" :key="row.weekday" class="heatmap__row">
              <span class="heatmap__day">{{ row.label }}</span>
              <span
                v-for="cell in row.cells"
                :key="cell.hour"
                class="heatmap__cell"
                :class="{ 'heatmap__cell--empty': !cell.trips }"
                :style="{ '--heat': hottestCell > 0 ? cell.distance / hottestCell : 0 }"
                :title="`${row.label}, ${cell.hour}:00 — ${cell.trips ? `${number(cell.trips, 0)} поездок, ${number(cell.distance, 0)} км` : 'не ездили'}`"
              />
            </div>
          </div>
          <p class="metric-meta">
            Выезжают между {{ usage.fromHour }}:00 и {{ usage.toHour }}:00, чаще всего в {{ usage.busiestHour }}:00
            <template v-if="busiestWeekdayLabel"> и по {{ busiestWeekdayLabel }}</template>.
            Между поездками машина стоит в среднем {{ hours(usage.standstill.averageHours) }}, самый долгий простой —
            {{ hours(usage.standstill.longestHours) }}. Без единой поездки прошло
            {{ number(usage.standstill.idleDays, 0) }} из {{ number(usage.standstill.daysCovered, 0) }} дней.
          </p>
        </template>
      </section>

      <section class="card card--wide">
        <div class="card__top">
          <div>
            <p class="metric-label">Куда уходит бензин</p>
            <p class="muted">Расход по средней скорости поездки — единственное, что в данных отличает пробку от трассы. Деньги посчитаны по литрам самой корзины</p>
          </div>
        </div>
        <p v-if="!speedRows.length" class="muted empty-note">За этот месяц нет поездок с известным расходом.</p>
        <div v-else class="speed-rows">
          <div v-for="(item, index) in speedRows" :key="item.name" class="speed-row">
            <div class="speed-row__head">
              <strong>{{ item.label }}</strong>
              <span class="muted">{{ speedRange(item, index) }}</span>
            </div>
            <span class="speed-row__track"><span class="speed-row__bar" :style="{ width: `${(item.consumption || 0) / worstConsumption * 100}%` }" /></span>
            <p class="speed-row__value">
              <strong>
                {{ number(item.consumption) }}
                <template v-if="item.consumptionUncertainty"> ± {{ number(item.consumptionUncertainty) }}</template>
                л/100 км
                <template v-if="item.cost != null"> · {{ money(item.cost, 0) }}</template>
              </strong>
              <span class="muted">{{ number(item.trips, 0) }} поездок · {{ number(item.distance) }} км · {{ number(item.fuelUsed) }} л</span>
            </p>
          </div>
        </div>
        <p v-if="speedSpread" class="metric-meta">
          Километр в пробке обходится в {{ number(speedSpread) }} раза дороже, чем на трассе.
        </p>
      </section>

      <section class="card card--wide">
        <div class="card__top">
          <div>
            <p class="metric-label">Насколько измерен расход</p>
            <p class="muted">
              Литры поездки — это разность двух показаний датчика, а он различает только целые проценты бака, то есть пол-литра.
              На коротком выезде такая ступенька и есть весь расход, поэтому сравнивать между собой можно не все поездки
            </p>
          </div>
        </div>
        <p v-if="!data?.quality.total" class="muted empty-note">За этот месяц завершённых поездок нет.</p>
        <template v-else>
          <p class="quality-line">
            <strong>{{ data.quality.measured }}</strong> из {{ data.quality.total }} поездок измерены достаточно точно,
            чтобы их расход можно было с чем-то сравнить. Остальные не выброшены из месячных сумм — там ошибки округления
            гасят друг друга, — но поодиночке их «л/100 км» не значат ничего.
          </p>
          <div v-if="data.quality.outliers.length" class="outliers">
            <p class="metric-label">Выбиваются из своей корзины</p>
            <ul class="outlier-list">
              <li v-for="item in data.quality.outliers" :key="item.id" class="outlier-row">
                <NuxtLink :to="`/trips?day=${moscowDay(item.startedAt)}`">{{ date(item.startedAt) }}</NuxtLink>
                <span>
                  {{ number(item.consumption) }} ± {{ number(item.errorBound) }} л/100 км ·
                  {{ item.deviation! > 0 ? '+' : '−' }}{{ number(Math.abs(item.deviation!)) }} к медиане
                  <template v-if="item.speed != null"> · {{ number(item.speed, 0) }} км/ч</template>
                </span>
              </li>
            </ul>
            <p class="metric-meta">
              Отклонение больше и собственной ошибки поездки, и разброса её корзины. Это либо действительно другая
              дорога, либо запись, которой достался чужой расход.
            </p>
          </div>
          <p v-else class="muted empty-note">Поездок, выбивающихся из своей корзины скорости, за месяц нет.</p>
        </template>
      </section>
    </div>
  </div>
</template>
