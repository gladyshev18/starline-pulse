<script setup lang="ts">
import { OIL_EQUIVALENT_SPEED_KMH, OIL_INTERVAL_KM, OIL_INTERVAL_MONTHS, OIL_INTERVAL_MOTOR_HOURS } from '~~/shared/service'

const { data, status, refresh } = await useFetch('/api/service')
const pending = ref(false)

function number(value: number | null | undefined, digits = 0) {
  if (value == null) return '—'
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value)
}
function date(value: string | Date | null | undefined) {
  return value ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long' }).format(new Date(value)) : '—'
}
function hours(minutes: number | null | undefined) {
  if (minutes == null) return '—'
  return `${number(minutes / 60, 0)} ч`
}
function duration(minutes: number | null | undefined) {
  if (minutes == null) return '—'
  const rounded = Math.round(minutes)
  const whole = Math.floor(rounded / 60)
  const rest = rounded % 60
  return whole ? `${whole} ч ${rest} мин` : `${rest} мин`
}
function percent(share: number | null | undefined) {
  return share == null ? '—' : `${number(share * 100, 0)} %`
}

const clockLabels: Record<string, string> = { km: 'пробег', hours: 'моточасы', months: 'календарь' }

const oil = computed(() => data.value?.oil)
// The whole point of the engine-hour clock is that it can disagree with the
// odometer; saying which one the service is actually due on is the answer the
// page exists to give.
// The headline is the remaining resource in the units of the clock that governs,
// because "осталось 47 %" tells you nothing you can act on and "осталось 201
// моточас" does.
// The remaining hours land on every one of the three Russian forms — 201 needs
// «моточас», 202 needs «моточаса» — and the wrong one is impossible to miss.
function motorHourWord(count: number) {
  const tens = count % 100
  const ones = count % 10
  if (tens >= 11 && tens <= 14) return 'моточасов'
  if (ones === 1) return 'моточас'
  if (ones >= 2 && ones <= 4) return 'моточаса'
  return 'моточасов'
}
function clockRemaining(item: { name: string, remaining: number } | null | undefined) {
  if (!item) return '—'
  if (item.name === 'km') return `${number(item.remaining)} км`
  if (item.name === 'hours') {
    const whole = Math.round(item.remaining)
    return `${number(whole)} ${motorHourWord(whole)}`
  }
  return `${number(item.remaining, 1)} мес`
}
const oilHeadline = computed(() => {
  const life = oil.value?.life
  if (!life?.binding) return 'Замена не записана'
  if (life.overdue) return 'Пора менять масло'
  return `Осталось ${clockRemaining(life.binding)}`
})
const oilNote = computed(() => {
  const life = oil.value?.life
  if (!life?.binding) return 'Запишите последнюю замену — без неё ресурс не от чего отсчитывать.'
  return `Считаем по строке «${clockLabels[life.binding.name]}» — она заканчивается первой.`
})
// Positive gap means the engine has been running more than the distance implies:
// the odometer would call for a change later than the oil deserves.
const clockAdvice = computed(() => {
  const gap = oil.value?.clockGap
  if (gap == null) return ''
  if (gap > 0.05) return 'Моточасы обгоняют пробег: по одному одометру масло меняли бы поздно.'
  if (gap < -0.05) return 'Пробег обгоняет моточасы: машина живёт на трассе, интервал в километрах с запасом.'
  return 'Обе шкалы идут вровень.'
})

// The counter cannot run behind the sessions in reality — it is the one thing
// polling cannot make it miss. When it does, the snapshots simply lack it for
// part of the month, and the difference measures the hole rather than anything
// about the engine.
const counterIncomplete = computed(() => {
  const engine = data.value?.engine
  if (!engine) return false
  return engine.sessionMinutes > 0 && engine.counterMinutes < engine.sessionMinutes * 0.95
})

const battery = computed(() => data.value?.battery)
// Degradation shows up over years, so for a long while the only honest headline
// is how much of the record exists so far.
const batteryHeadline = computed(() => {
  const trend = battery.value
  if (!trend || !trend.days) return 'Нет ночных замеров'
  if (trend.currentVolts == null) return 'Данных пока мало'
  return `${number(trend.currentVolts, 2)} В покоя`
})
function plural(count: number, one: string, few: string, many: string) {
  const tens = count % 100
  const ones = count % 10
  if (tens >= 11 && tens <= 14) return many
  if (ones === 1) return one
  if (ones >= 2 && ones <= 4) return few
  return many
}
const batteryNote = computed(() => {
  const trend = battery.value
  if (!trend || !trend.days) return 'Напряжение покоя измеряется ночью, когда двигатель давно выключен.'
  const collected = `${number(trend.days)} ${plural(trend.days, 'ночь', 'ночи', 'ночей')}`
    + ` за ${number(trend.spanDays)} ${plural(Math.round(trend.spanDays), 'день', 'дня', 'дней')}`
  if (!trend.confident) {
    // Two different reasons look the same from outside, and only one of them is
    // about waiting: a short record needs more nights, a flat one needs nothing.
    const enough = trend.days >= 45 && trend.spanDays >= 60
    return enough
      ? `${collected} — заметного тренда нет, напряжение держится.`
      : `${collected} — для вывода о тренде нужно около двух месяцев наблюдений.`
  }
  const perMonth = trend.slopePerMonth!
  const direction = perMonth < 0 ? 'теряет' : 'набирает'
  const forecast = trend.daysToWarning == null
    ? ''
    : ` · до 12,2 В около ${number(trend.daysToWarning / 30.437, 0)} мес`
  return `${direction} ${number(Math.abs(perMonth), 3)} В в месяц ± ${number(trend.standardError!, 3)}${forecast}`
})

async function remove(id: number) {
  if (pending.value) return
  pending.value = true
  try {
    await $fetch(`/api/service/${id}`, { method: 'DELETE' })
    await refresh()
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <div>
    <header class="page-heading">
      <div><p class="eyebrow">Автомобиль</p><h1 class="page-title">Обслуживание</h1></div>
    </header>

    <div v-if="status === 'pending'" class="card skeleton">Загрузка…</div>
    <div v-else class="grid">
      <section class="card card--wide">
        <div class="card__top">
          <p class="metric-label">Моторное масло</p>
          <span v-if="oil?.life.overdue" class="metric-badge metric-badge--warn">просрочено</span>
        </div>
        <p class="metric metric--compact">{{ oilHeadline }}</p>
        <p class="muted">{{ oilNote }}</p>

        <div v-if="oil?.life.clocks.length" class="oil-clocks">
          <div v-for="item in oil.life.clocks" :key="item.name" class="oil-clock" :class="{ 'oil-clock--binding': item.name === oil.life.binding?.name }">
            <p class="oil-clock__label">{{ clockLabels[item.name] }}</p>
            <span class="oil-clock__track"><span class="oil-clock__bar" :style="{ width: `${Math.min(100, item.share * 100)}%` }" /></span>
            <p class="oil-clock__value">
              <strong>{{ item.remaining > 0 ? `осталось ${clockRemaining(item)}` : 'исчерпано' }}</strong>
              <span class="muted">
                {{ percent(item.share) }} ·
                {{ item.name === 'km' ? `${number(item.used)} из ${number(OIL_INTERVAL_KM)} км` : '' }}
                {{ item.name === 'hours' ? `${number(item.used)} из ${number(OIL_INTERVAL_MOTOR_HOURS)} ч` : '' }}
                {{ item.name === 'months' ? `${number(item.used, 1)} из ${OIL_INTERVAL_MONTHS} мес` : '' }}
              </span>
            </p>
          </div>
        </div>
        <p v-if="clockAdvice" class="metric-meta">{{ clockAdvice }}</p>
        <p v-if="oil?.service" class="metric-meta">
          Последняя замена {{ date(oil.service.performedAt) }}<span v-if="oil.service.mileage"> на {{ number(oil.service.mileage) }} км</span>
          <span v-if="oil.kmPerHour"> · с тех пор {{ number(oil.kmPerHour) }} км на моточас, шкалы сходятся на {{ OIL_EQUIVALENT_SPEED_KMH }}</span>
        </p>
        <p class="metric-meta">
          Интервал в моточасах взят не из пробега, а из ресурса масла: синтетика держит 250–300 моточасов в обычных условиях
          и 200–250 в тяжёлых — зимой, в пробках, на турбомоторе.
        </p>
      </section>

      <section class="card card--half">
        <div class="card__top"><p class="metric-label">Моточасы</p></div>
        <p class="metric">{{ hours(data?.motorMinutes) }}</p>
        <p class="muted">Счётчик охранного комплекса<span v-if="data?.mileage"> · пробег {{ number(data.mileage) }} км</span></p>
      </section>

      <section class="card card--half">
        <div class="card__top"><p class="metric-label">Двигатель за месяц</p></div>
        <p class="metric metric--compact">{{ duration(data?.engine.counterMinutes) }}</p>
        <p class="muted">По счётчику · сессиями учтено {{ duration(data?.engine.sessionMinutes) }}</p>
        <p v-if="counterIncomplete" class="metric-meta">
          Счётчик заполнен не на весь месяц, поэтому сравнивать его с сессиями пока не с чем.
        </p>
        <p v-else-if="data && data.engine.unattributedMinutes > 0.5" class="metric-meta">
          {{ duration(data.engine.unattributedMinutes) }} работы двигателя не попало ни в одну сессию — на столько же занижены прогревы.
        </p>
      </section>

      <section class="card card--wide">
        <div class="card__top">
          <p class="metric-label">Аккумулятор</p>
          <span v-if="battery?.confident && (battery.slopePerMonth || 0) < 0" class="metric-badge metric-badge--warn">снижается</span>
        </div>
        <p class="metric metric--compact">{{ batteryHeadline }}</p>
        <p class="muted">{{ batteryNote }}</p>
        <p v-if="battery?.ambientAdjusted" class="metric-meta">
          Поправка на уличную температуру учтена: холод сам по себе роняет напряжение покоя, и без неё зима выглядела бы деградацией.
        </p>
      </section>

      <section class="card card--wide card--table">
        <div class="card__top"><p class="metric-label">Журнал замен</p></div>
        <p v-if="!data?.events.length" class="muted">Записей пока нет.</p>
        <div v-else class="table-wrap">
          <table>
            <thead><tr><th>Дата</th><th>Пробег</th><th>Моточасы</th><th>Заметка</th><th /></tr></thead>
            <tbody>
              <tr v-for="item in data.events" :key="item.id">
                <td>{{ date(item.performedAt) }}</td>
                <td>{{ number(item.mileage) }} км</td>
                <td>{{ hours(item.motorMinutes) }}</td>
                <td>{{ item.note || '—' }}</td>
                <td><button class="btn btn--secondary" type="button" :disabled="pending" @click="remove(item.id)">Удалить</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

  </div>
</template>
