<script setup lang="ts">
import { currentMoscowMonth, monthTitle as formatMonthTitle, moscowMonthRange, shiftMonth } from '~~/shared/moscow-month'

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
        <div class="card__top"><p class="metric-label">Километр стоит</p></div>
        <p class="metric">{{ money(data?.totals.costPerKm) }}</p>
        <p class="metric-meta">
          <span v-if="data?.totals.pricePerLitre != null">Топливо по {{ money(data.totals.pricePerLitre) }}/л · {{ number(data.totals.fuelUsed) }} л на {{ number(data.totals.distance) }} км</span>
          <span v-else>Нет чеков — цена литра неизвестна</span>
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
          Литры здесь — по завершённым поездкам, поэтому в сумме их меньше, чем израсходовано за месяц: прогревы за руль никто не сажал.
        </p>
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
    </div>
  </div>
</template>
