<script setup lang="ts">
import { fuelToFull } from '~~/shared/fuel'

const { data, status } = await useFetch('/api/dashboard')

function number(value: number | null | undefined, digits = 0) {
  if (value == null) return '—'
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value)
}
function money(value: number | null | undefined, digits = 0) {
  if (value == null) return '—'
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: digits }).format(value)
}
function date(value: string | Date | null | undefined) {
  return value ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Нет данных'
}
function batteryUnit(type: string | null | undefined) {
  return type === 'percent' ? '%' : type === 'volt' ? 'В' : ''
}
function dailyChange(value: number | null | undefined, direction: '+' | '−', unit: string) {
  const amount = Math.max(0, value || 0)
  return `${amount > 0 ? direction : ''}${number(amount, 1)} ${unit}`
}
function isStale(value: string | Date | null | undefined) {
  if (!value) return false
  const reference = data.value?.snapshot?.activityTs || data.value?.snapshot?.ts
  return Boolean(reference && new Date(reference).getTime() - new Date(value).getTime() > 30 * 60_000)
}
function updated(value: string | Date | null | undefined) {
  if (!value) return 'Время обновления неизвестно'
  return `${isStale(value) ? 'Данные устарели' : 'Данные на'} ${date(value)}`
}
const vehicleState = computed(() => {
  const snapshot = data.value?.snapshot
  if (!snapshot || snapshot.online == null) return 'Состояние неизвестно'
  if (!snapshot.online) return 'Не на связи'
  if (snapshot.ignition == null) return 'Состояние двигателя неизвестно'
  return snapshot.ignition ? 'Заведена' : 'Припаркована'
})
const litresToFull = computed(() => fuelToFull(data.value?.snapshot?.fuel))
// A month rarely holds more than a handful of refuels, so the count lands on
// every one of the three Russian forms and the wrong one is impossible to miss.
function refuelWord(count: number) {
  const tens = count % 100
  const ones = count % 10
  if (tens >= 11 && tens <= 14) return 'заправок'
  if (ones === 1) return 'заправка'
  if (ones >= 2 && ones <= 4) return 'заправки'
  return 'заправок'
}
// A refuel without a receipt keeps its money out of the total, so their number
// is spelled out: to anyone who remembers how often the tank was filled the sum
// would otherwise look simply wrong.
const fuelCostNote = computed(() => {
  const cost = data.value?.fuelCost
  if (!cost) return ''
  const parts = [`${number(cost.refuels)} ${refuelWord(cost.refuels)}`]
  if (cost.pricePerLitre != null) parts.push(`${money(cost.pricePerLitre, 2)}/л`)
  if (cost.unknown > 0) parts.push(`у ${number(cost.unknown)} нет суммы`)
  return parts.join(' · ')
})
const maxDailyDistance = computed(() => Math.max(1, ...(data.value?.daily || []).map(item => item.distance)))
function dailyBarHeight(distance: number) {
  return `${distance > 0 ? Math.max(6, distance / maxDailyDistance.value * 100) : 2}%`
}
function shortDay(value: string) {
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }).format(new Date(`${value}T00:00:00+03:00`))
}
// The chart keeps fourteen columns whatever the screen, so on a phone the month
// half of the label is dropped by CSS and only the day number is left standing.
function dayNumber(value: string) {
  return shortDay(value).slice(0, 2)
}
function dayMonth(value: string) {
  return shortDay(value).slice(2)
}
function duration(minutes: number | null | undefined) {
  if (!minutes) return '0 мин'
  const rounded = Math.round(minutes)
  const hours = Math.floor(rounded / 60)
  const rest = rounded % 60
  return hours ? `${hours} ч ${rest} мин` : `${rest} мин`
}
</script>

<template>
  <div>
    <header class="page-heading">
      <div><p class="eyebrow">Обзор</p><h1 class="page-title">{{ data?.vehicle?.alias || 'Автомобиль' }}</h1></div>
    </header>
    <div v-if="status === 'pending'" class="card skeleton">Загрузка…</div>
    <div v-else class="grid">
      <div class="status-overview" aria-label="Состояние автомобиля">
        <section class="card state-card">
          <div class="card__top"><p class="eyebrow">Состояние</p></div>
          <div class="state-card__body">
            <div><h2><span class="status-dot" :class="{ 'status-dot--on': data?.snapshot?.online && data?.snapshot?.ignition, 'status-dot--offline': data?.snapshot?.online === false }" />{{ vehicleState }}</h2><p class="muted">Последняя связь: {{ date(data?.snapshot?.activityTs) }}</p></div>
          </div>
        </section>
        <section class="card metric-card"><div class="card__top"><p class="metric-label">Пробег</p><span class="metric-badge">{{ dailyChange(data?.today.distance, '+', 'км') }}</span></div><p class="metric">{{ number(data?.snapshot?.mileage, 1) }} <small>км</small></p><p class="metric-meta" :class="{ 'metric-meta--stale': isStale(data?.snapshot?.mileageTs) }">{{ updated(data?.snapshot?.mileageTs) }}</p></section>
        <section class="card metric-card"><div class="card__top"><p class="metric-label">Топливо</p><span class="metric-badge">{{ dailyChange(data?.today.fuelUsed, '−', 'л') }}</span></div><p class="metric">{{ number(data?.snapshot?.fuel, 1) }} <small>л</small></p><div class="metric-card__footer"><p class="metric-meta metric-meta--primary">До полного бака: {{ number(litresToFull, 1) }} л</p><p class="metric-meta" :class="{ 'metric-meta--stale': isStale(data?.snapshot?.fuelTs) }">{{ data?.snapshot?.fuelPercent == null ? '' : `${number(data.snapshot.fuelPercent)}% · ` }}{{ data?.snapshot?.fuelSource === 'converted' ? 'пересчёт API · ' : '' }}{{ updated(data?.snapshot?.fuelTs) }}</p></div></section>
        <section class="card metric-card"><div class="card__top"><p class="metric-label">Аккумулятор</p></div><p class="metric">{{ number(data?.snapshot?.battery, 1) }} <small>{{ batteryUnit(data?.snapshot?.batteryType) }}</small></p><p class="metric-meta" :class="{ 'metric-meta--stale': isStale(data?.snapshot?.commonTs) }">{{ updated(data?.snapshot?.commonTs) }}</p></section>
      </div>
      <section class="card card--wide activity-card">
        <div class="card__top"><div><p class="metric-label">Пробег за 14 дней</p><p class="muted">{{ number(data?.daily.reduce((sum, item) => sum + item.distance, 0), 1) }} км · {{ number(data?.daily.reduce((sum, item) => sum + item.trips, 0)) }} поездок</p></div></div>
        <div class="daily-chart" aria-label="Дневной пробег за последние 14 дней">
          <NuxtLink
            v-for="item in data?.daily"
            :key="item.day"
            class="daily-chart__item"
            :to="{ path: '/trips', query: { day: item.day } }"
            :title="`${shortDay(item.day)}: ${number(item.distance, 1)} км, ${item.trips} поездок`"
            :aria-label="`Открыть поездки за ${shortDay(item.day)}: ${number(item.distance, 1)} км, ${item.trips} поездок`"
          >
            <span class="daily-chart__value">{{ item.distance > 0 ? number(item.distance, 0) : '—' }}</span>
            <span class="daily-chart__track"><span class="daily-chart__bar" :style="{ height: dailyBarHeight(item.distance) }" /></span>
            <span class="daily-chart__day">{{ dayNumber(item.day) }}<span class="daily-chart__day-month">{{ dayMonth(item.day) }}</span></span>
          </NuxtLink>
        </div>
      </section>
      <section class="card card--half"><div class="card__top"><p class="metric-label">За месяц</p></div><p class="metric">{{ number(data?.month.distance, 1) }} <small>км</small></p><p class="muted">{{ number(data?.month.trips) }} поездок · {{ number(data?.month.fuelUsed, 1) }} л · {{ number(data?.month.consumption, 1) }} л/100 км</p></section>
      <section class="card card--half"><div class="card__top"><p class="metric-label">Затраты на бензин</p></div><p class="metric metric--compact">{{ money(data?.fuelCost.amount) }}</p><p class="muted">За месяц · {{ fuelCostNote }}</p></section>
      <section class="card card--half"><div class="card__top"><p class="metric-label">Работа без движения</p></div><p class="metric metric--compact">{{ duration(data?.engine.stationaryMinutes) }}</p><p class="muted">За месяц · до начала движения {{ duration(data?.engine.warmupMinutes) }} · сессий двигателя {{ number(data?.engine.sessions) }}</p></section>
      <section class="card card--half"><div class="card__top"><p class="metric-label">Заправки</p></div><p class="metric">{{ number(data?.refuels.litres, 1) }} <small>л</small></p><p class="muted">{{ number(data?.refuels.count) }} за месяц<span v-if="data?.refuels.recent[0]"> · последняя {{ date(data.refuels.recent[0].detectedAt) }}</span></p></section>
      <section class="card card--wide battery-card">
        <div class="card__top"><div><p class="metric-label">АКБ за 7 дней</p><p class="muted">Дневные минимумы, средние и максимумы</p></div></div>
        <div v-if="data?.batteryTrend.length" class="battery-trend">
          <div v-for="item in data.batteryTrend" :key="item.day" class="battery-trend__row">
            <span>{{ shortDay(item.day) }}</span><strong>{{ number(item.min, 2) }} В</strong><span>{{ number(item.average, 2) }} В среднее</span><span>{{ number(item.max, 2) }} В максимум</span>
          </div>
        </div>
        <p v-else class="muted empty-note">Пока недостаточно данных для тренда.</p>
      </section>
    </div>
  </div>
</template>
