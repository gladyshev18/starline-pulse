<script setup lang="ts">
const route = useRoute()

function currentMonth() {
  const now = new Date(Date.now() + 3 * 60 * 60_000)
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

function validMonth(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) return null
  const [year, month] = value.split('-').map(Number)
  return year && month && month >= 1 && month <= 12 ? value : null
}

function shiftMonth(value: string, amount: number) {
  const [year, month] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year!, month! - 1 + amount, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

const month = computed(() => validMonth(route.query.month) || currentMonth())
const { data, status } = await useFetch('/api/history', { query: computed(() => ({ month: month.value })) })
const chartMode = ref<'daily' | 'odometer'>('daily')
const canGoNext = computed(() => month.value < (data.value?.currentMonth || currentMonth()))
const hasData = computed(() => Boolean(data.value?.daily.some(item => item.distance > 0 || item.fuelUsed > 0)))
const hasOdometerData = computed(() => (data.value?.odometer.length || 0) > 1)
const odometerStart = computed(() => data.value?.odometer[0]?.mileage)
const odometerEnd = computed(() => data.value?.odometer.at(-1)?.mileage)
const odometerDistance = computed(() => {
  if (odometerStart.value == null || odometerEnd.value == null) return null
  return Math.max(0, odometerEnd.value - odometerStart.value)
})

const monthTitle = computed(() => {
  const [year, monthNumber] = month.value.split('-').map(Number)
  const title = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' })
    .format(new Date(Date.UTC(year!, monthNumber! - 1, 1)))
  return title[0]?.toUpperCase() + title.slice(1)
})

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

const speedRows = computed(() => (data.value?.bySpeed || []).filter(item => item.trips > 0))
// A bar chart of consumption needs a ceiling, and the jam bucket is always the
// ceiling: idling burns fuel and covers no ground.
const worstConsumption = computed(() => Math.max(1, ...speedRows.value.map(item => item.consumption || 0)))
function speedRange(item: { name: string, upTo: number }, index: number) {
  const from = index === 0 ? 0 : speedRows.value[index - 1]!.upTo
  return Number.isFinite(item.upTo) ? `${from}–${item.upTo} км/ч` : `от ${from} км/ч`
}
const cheapest = computed(() => speedRows.value.reduce<number | null>((best, item) => {
  if (item.consumption == null) return best
  return best == null || item.consumption < best ? item.consumption : best
}, null))
const dearest = computed(() => speedRows.value.reduce<number | null>((worst, item) => {
  if (item.consumption == null) return worst
  return worst == null || item.consumption > worst ? item.consumption : worst
}, null))
const speedSpread = computed(() => {
  if (cheapest.value == null || dearest.value == null || cheapest.value <= 0) return null
  const ratio = dearest.value / cheapest.value
  return ratio >= 1.2 ? ratio : null
})

useHead({ title: computed(() => `История — ${monthTitle.value} — Chery Pulse`) })
</script>

<template>
  <div>
    <header class="page-heading history-heading">
      <div><p class="eyebrow">Статистика</p><h1 class="page-title">История</h1></div>
      <nav class="month-switcher" aria-label="Выбор месяца">
        <NuxtLink
          class="icon-button month-switcher__arrow"
          :to="{ query: { month: shiftMonth(month, -1) } }"
          aria-label="Предыдущий месяц"
          title="Предыдущий месяц"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
        </NuxtLink>
        <strong>{{ monthTitle }}</strong>
        <NuxtLink
          v-if="canGoNext"
          class="icon-button month-switcher__arrow"
          :to="{ query: { month: shiftMonth(month, 1) } }"
          aria-label="Следующий месяц"
          title="Следующий месяц"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
        </NuxtLink>
        <span v-else class="icon-button month-switcher__arrow month-switcher__arrow--disabled" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></svg>
        </span>
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
          <div class="chart-switcher" role="tablist" aria-label="Вид графика">
            <button
              type="button"
              role="tab"
              :aria-selected="chartMode === 'daily'"
              :class="{ 'chart-switcher__button--active': chartMode === 'daily' }"
              class="chart-switcher__button"
              @click="chartMode = 'daily'"
            >
              По дням
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="chartMode === 'odometer'"
              :class="{ 'chart-switcher__button--active': chartMode === 'odometer' }"
              class="chart-switcher__button"
              @click="chartMode = 'odometer'"
            >
              Одометр
            </button>
          </div>
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
            <p class="metric-label">Куда уходит бензин</p>
            <p class="muted">Расход по средней скорости поездки — единственное, что в данных отличает пробку от трассы</p>
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
              <strong>{{ number(item.consumption) }} л/100 км</strong>
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
