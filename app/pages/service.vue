<script setup lang="ts">
import { OIL_INTERVAL_KM, OIL_INTERVAL_MONTHS, OIL_INTERVAL_MOTOR_HOURS, OIL_REFERENCE_SPEED_KMH } from '~~/shared/service'

const { data, status, refresh } = await useFetch('/api/service')
const adding = ref(false)
const pending = ref(false)
const formError = ref('')
const form = reactive({ performedAt: '', mileage: '', note: '' })

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
const oilHeadline = computed(() => {
  const life = oil.value?.life
  if (!life?.binding) return 'Замена не записана'
  if (life.overdue) return 'Пора менять масло'
  return `Осталось ${percent(1 - life.binding.share)} ресурса`
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

function resetForm() {
  form.performedAt = new Date().toISOString().slice(0, 10)
  form.mileage = ''
  form.note = ''
  formError.value = ''
}
function openForm() {
  resetForm()
  adding.value = true
}
function errorMessage(error: unknown) {
  if (typeof error === 'object' && error) {
    const value = error as { data?: { statusMessage?: string }, statusMessage?: string }
    return value.data?.statusMessage || value.statusMessage || 'Не удалось сохранить запись'
  }
  return 'Не удалось сохранить запись'
}
async function save() {
  if (pending.value) return
  pending.value = true
  formError.value = ''
  try {
    await $fetch('/api/service', { method: 'POST', body: { ...form } })
    await refresh()
    adding.value = false
  } catch (error) {
    formError.value = errorMessage(error)
  } finally {
    pending.value = false
  }
}
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
      <button class="btn" type="button" @click="openForm">Записать замену масла</button>
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
              <strong>{{ percent(item.share) }}</strong>
              <span class="muted">
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
          <span v-if="oil.kmPerHour"> · с тех пор {{ number(oil.kmPerHour) }} км на моточас при опорных {{ OIL_REFERENCE_SPEED_KMH }}</span>
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

    <AppModal
      :model-value="adding"
      title="Замена масла"
      eyebrow="Обслуживание"
      :close-on-backdrop="!pending"
      :close-on-escape="!pending"
      @update:model-value="value => { if (!value && !pending) adding = false }"
    >
      <form id="service-form" class="refuel-details-form" @submit.prevent="save">
        <div>
          <label for="service-date">Дата замены</label>
          <input id="service-date" v-model="form.performedAt" type="date" :disabled="pending">
        </div>
        <div>
          <label for="service-mileage">Пробег, км</label>
          <input id="service-mileage" v-model="form.mileage" inputmode="decimal" placeholder="возьмём из снимка" :disabled="pending">
        </div>
        <div class="refuel-details-form__wide">
          <label for="service-note">Заметка</label>
          <input id="service-note" v-model="form.note" maxlength="200" placeholder="Например, марка масла и фильтра" :disabled="pending">
        </div>
        <p v-if="formError" class="error refuel-details-form__wide">{{ formError }}</p>
      </form>
      <template #footer>
        <button class="btn btn--secondary" type="button" :disabled="pending" @click="adding = false">Отмена</button>
        <button class="btn" type="submit" form="service-form" :disabled="pending">{{ pending ? 'Сохраняем…' : 'Записать' }}</button>
      </template>
    </AppModal>
  </div>
</template>
