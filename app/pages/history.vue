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
        <p class="metric-meta">За выбранный месяц</p>
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
    </div>
  </div>
</template>
