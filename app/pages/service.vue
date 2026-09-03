<script setup lang="ts">
import { OIL_EQUIVALENT_SPEED_KMH, OIL_INTERVAL_KM, OIL_INTERVAL_MONTHS, OIL_INTERVAL_MOTOR_HOURS, OIL_KM_PER_DAY, OIL_MOTOR_HOURS_PER_DAY } from '~~/shared/service'

const { data, status, refresh } = await useFetch('/api/service')
const { data: documents, refresh: refreshDocuments } = await useFetch('/api/service-documents')
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
function money(value: number | null | undefined) {
  if (value == null) return '—'
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(value)
}
function errorMessage(error: unknown) {
  if (typeof error === 'object' && error) {
    const value = error as { data?: { statusMessage?: string }, statusMessage?: string }
    return value.data?.statusMessage || value.statusMessage || 'Не удалось сохранить'
  }
  return 'Не удалось сохранить'
}
function percent(share: number | null | undefined) {
  return share == null ? '—' : `${number(share * 100, 0)} %`
}

const clockLabels: Record<string, string> = { km: 'пробег', hours: 'моточасы', months: 'календарь' }

const fixedCostForm = reactive({ label: '', amount: '', startsAt: '', endsAt: '' })
const fixedCostError = ref('')
// Средний месяц года, а не тот, что на календаре: колонка сравнивает расходы
// между собой, и для этого им нужен один и тот же знаменатель.
const AVERAGE_MONTH_DAYS = 30.437
function monthlyShare(item: { amount: number, startsAt: string | Date, endsAt: string | Date }) {
  const days = (new Date(item.endsAt).getTime() - new Date(item.startsAt).getTime()) / (24 * 60 * 60_000)
  return days > 0 ? item.amount / days * AVERAGE_MONTH_DAYS : null
}
async function addFixedCost() {
  if (pending.value) return
  pending.value = true
  fixedCostError.value = ''
  try {
    await $fetch('/api/fixed-costs', { method: 'POST', body: { ...fixedCostForm } })
    fixedCostForm.label = ''
    fixedCostForm.amount = ''
    fixedCostForm.endsAt = ''
    await refresh()
  } catch (error) {
    fixedCostError.value = errorMessage(error)
  } finally {
    pending.value = false
  }
}
async function removeFixedCost(id: number) {
  if (pending.value) return
  pending.value = true
  try {
    await $fetch(`/api/fixed-costs/${id}`, { method: 'DELETE' })
    await refresh()
  } catch (error) {
    fixedCostError.value = errorMessage(error)
  } finally {
    pending.value = false
  }
}

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
// Темп — второй вопрос после остатка. «Осталось 4000 км» означает и полгода
// спокойной жизни, и шесть недель, и разницу между ними знает только суточный
// пробег.
const pace = computed(() => data.value?.oil?.pace ?? null)
function paceOf(name: 'km' | 'hours' | 'months') {
  return pace.value?.clocks.find(item => item.name === name) ?? null
}
const kmPace = computed(() => paceOf('km'))
const hoursPace = computed(() => paceOf('hours'))

// Знак читается быстрее величины: «+51 %» и «−20 %» сразу говорят про обгон и
// отставание, а «151 % нормы» приходится делить в уме.
function signedPercent(ratio: number | null | undefined) {
  if (ratio == null) return '—'
  const excess = (ratio - 1) * 100
  const sign = excess >= 0.5 ? '+' : excess <= -0.5 ? '−' : ''
  return `${sign}${number(Math.abs(excess), 0)} %`
}

// Насколько пробег обгоняет время — то же самое число, что и превышение
// суточной нормы: обе доли меряются от одного интервала, поэтому одна фраза
// отвечает сразу на оба вопроса.
const paceSummary = computed(() => {
  const km = kmPace.value
  if (!km) return ''
  const excess = Math.round((km.ratio - 1) * 100)
  if (excess > 5) return `Пробег обгоняет время на ${excess} %: ${number(OIL_INTERVAL_KM)} км при таком темпе кончатся раньше года.`
  if (excess < -5) return `Пробег отстаёт от времени на ${Math.abs(excess)} %: раньше выйдет календарный срок, а не километры.`
  return 'Пробег и календарь идут вровень — обе шкалы кончатся примерно вместе.'
})

// Дата, а не доля: «осталось 47 %» ничего не говорит о том, когда записываться,
// а «около 3 марта» говорит.
const paceDue = computed(() => {
  const item = pace.value
  if (!item?.dueAt || !item.binding || item.daysLeft == null) return ''
  const days = Math.round(item.daysLeft)
  return `${date(item.dueAt)} · через ${number(days)} ${plural(days, 'день', 'дня', 'дней')}, по строке «${clockLabels[item.binding.name]}»`
})

// Сколько можно проезжать в сутки, чтобы километры дотянули ровно до
// календарного срока. Это уже не наблюдение, а норма на остаток интервала.
const paceAllowance = computed(() => {
  const km = kmPace.value
  return km?.allowancePerDay == null ? '' : `${number(km.allowancePerDay, 1)} км/сут`
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

// Engine time that fell between two polls entirely. Which of it counts as a
// warm-up is settled by the odometer, so the two halves are named apart: the
// standing one is already on the overview's idling bill, and the moving one is a
// trip that never became a session and never will.
const untrackedNote = computed(() => {
  const engine = data.value?.engine
  if (!engine) return ''
  const parts: string[] = []
  if (engine.untrackedIdleMinutes > 0.5) parts.push(`${duration(engine.untrackedIdleMinutes)} на месте — учтены в прогревах`)
  if (engine.untrackedMovingMinutes > 0.5) parts.push(`${duration(engine.untrackedMovingMinutes)} с пробегом — этого в поездках нет`)
  if (!parts.length) return ''
  return `Мимо сессий прошло ${duration(engine.untrackedIdleMinutes + engine.untrackedMovingMinutes)}: ${parts.join(', ')}.`
})
// A stretch nobody recorded has no trip to open, so the only way to recognise it
// is to spell out when it was and how far the odometer moved over it.
function dateTime(value: string | Date) {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
const untrackedTrips = computed(() => (data.value?.engine.untrackedTrips || [])
  .filter(item => item.minutes > 0.5)
  .map(item => ({
    key: String(item.startedAt),
    label: `${dateTime(item.startedAt)} — ${dateTime(item.endedAt)}`,
    detail: item.distance == null
      ? `${duration(item.minutes)}, одометр молчал`
      : `${duration(item.minutes)}, ${number(item.distance, 1)} км`
  })))

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

type ServiceDocumentRow = NonNullable<typeof documents.value>['items'][number]

const editing = ref<ServiceDocumentRow | null>(null)
const documentError = ref('')
const documentForm = reactive({
  performedAt: '',
  mileage: '',
  totalAmount: '',
  vendor: '',
  orderNumber: '',
  note: '',
  createOilEvent: true
})

function parsedDetails(item: ServiceDocumentRow) {
  if (!item.parsedJson) return null
  try {
    return JSON.parse(item.parsedJson) as {
      confidence?: number
      attempts?: number
      mentionsOil?: boolean
      mileageSource?: string | null
      votes?: Record<string, number>
      disputed?: Record<string, boolean>
    }
  } catch {
    return null
  }
}

function documentState(item: ServiceDocumentRow) {
  if (item.serviceEventId) return 'подтверждён'
  if (!item.parsedAt) return 'распознаётся…'
  return 'не подтверждён'
}

// What the recognition made of a field, so the form says which values it stands
// behind and which are a single shaky read the person should check first.
function fieldHint(field: 'orderNumber' | 'performedAt' | 'mileage' | 'totalAmount') {
  const details = editing.value ? parsedDetails(editing.value) : null
  if (!details) return ''
  if (field === 'mileage' && details.mileageSource === 'snapshots') return 'из истории пробега машины'
  const votes = details.votes?.[field] ?? 0
  if (!votes) return 'не распознано — впишите вручную'
  if (details.disputed?.[field]) return 'распознано неуверенно — проверьте'
  return votes > 1 ? `распознано, ${votes} совпадения` : 'распознано одним проходом'
}

const parseSummary = computed(() => {
  const item = editing.value
  if (!item) return ''
  if (!item.parsedAt) return 'Распознавание ещё не закончилось — обновите страницу через минуту.'
  const details = parsedDetails(item)
  if (!details?.attempts) return 'Распознать не удалось: заполните поля вручную.'
  return `Распознано с ${details.attempts} проходов, уверенность ${details.confidence ?? '—'}.`
})

function toDateInput(value: string | Date | null | undefined) {
  if (!value) return ''
  // The stored moment is midday Moscow, so the Moscow calendar day is the one to
  // put in the field whatever the browser's timezone is.
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date(value))
}

function openDocument(item: ServiceDocumentRow) {
  editing.value = item
  documentError.value = ''
  documentForm.performedAt = toDateInput(item.performedAt)
  documentForm.mileage = item.mileage == null ? '' : String(item.mileage)
  documentForm.totalAmount = item.totalAmount == null ? '' : String(item.totalAmount)
  documentForm.vendor = item.vendor || ''
  documentForm.orderNumber = item.orderNumber || ''
  documentForm.note = item.note || ''
  documentForm.createOilEvent = parsedDetails(item)?.mentionsOil !== false
}

async function reparseDocument() {
  if (!editing.value || pending.value) return
  pending.value = true
  documentError.value = ''
  try {
    await $fetch(`/api/service-documents/${editing.value.id}/parse`, { method: 'POST' })
    documentError.value = 'Отправил на повторное распознавание — займёт около минуты.'
  } catch (error) {
    documentError.value = errorMessage(error)
  } finally {
    pending.value = false
  }
}

async function confirmDocument() {
  if (!editing.value || pending.value) return
  pending.value = true
  documentError.value = ''
  try {
    await $fetch(`/api/service-documents/${editing.value.id}/confirm`, { method: 'POST', body: { ...documentForm } })
    await Promise.all([refreshDocuments(), refresh()])
    editing.value = null
  } catch (error) {
    documentError.value = errorMessage(error)
  } finally {
    pending.value = false
  }
}

async function removeDocument(id: number) {
  if (pending.value) return
  pending.value = true
  try {
    await $fetch(`/api/service-documents/${id}`, { method: 'DELETE' })
    await refreshDocuments()
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
        <div v-if="pace" class="pace-list">
          <p class="pace-caption">Темп за {{ number(pace.days) }} {{ plural(Math.round(pace.days), 'день', 'дня', 'дней') }} после замены</p>
          <p v-if="kmPace" class="pace-row">
            <span>Пробег</span>
            <strong>{{ number(kmPace.perDay, 1) }} км/сут · норма {{ number(OIL_KM_PER_DAY, 1) }} · {{ signedPercent(kmPace.ratio) }}</strong>
          </p>
          <p v-if="hoursPace" class="pace-row">
            <span>Моточасы</span>
            <strong>{{ number(hoursPace.perDay, 2) }} ч/сут · норма {{ number(OIL_MOTOR_HOURS_PER_DAY, 2) }} · {{ signedPercent(hoursPace.ratio) }}</strong>
          </p>
          <p v-if="paceAllowance" class="pace-row">
            <span>Чтобы дотянуть до срока</span>
            <strong>не больше {{ paceAllowance }}</strong>
          </p>
          <p v-if="paceDue" class="pace-row">
            <span>При этом темпе замена</span>
            <strong>{{ paceDue }}</strong>
          </p>
        </div>
        <p v-if="paceSummary" class="metric-meta">{{ paceSummary }}</p>
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
        <template v-else-if="untrackedNote">
          <p class="metric-meta">{{ untrackedNote }}</p>
          <p v-for="item in untrackedTrips" :key="item.key" class="metric-meta">
            {{ item.label }} · {{ item.detail }}
          </p>
        </template>
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
        <div class="card__top">
          <div>
            <p class="metric-label">Документы по ТО</p>
            <p class="muted">
              Пришлите акт боту — он сохранит его здесь и распознает.
              Отправляйте <b>как файл</b>: обычное фото Telegram сжимает до 1280 px, и мелкий текст в таблице теряется.
            </p>
          </div>
        </div>
        <p v-if="!documents?.items.length" class="muted">Документов пока нет.</p>
        <div v-else class="table-wrap">
          <table role="table">
            <thead role="rowgroup"><tr role="row"><th role="columnheader">Получен</th><th role="columnheader">Дата работ</th><th role="columnheader">Пробег</th><th role="columnheader">Сумма</th><th role="columnheader">Файл</th><th role="columnheader" /></tr></thead>
            <tbody role="rowgroup">
              <tr v-for="item in documents.items" :key="item.id" role="row">
                <td role="cell" data-label="Получен">{{ date(item.receivedAt) }}</td>
                <td role="cell" data-label="Дата работ">{{ item.performedAt ? date(item.performedAt) : documentState(item) }}</td>
                <td role="cell" data-label="Пробег">{{ item.mileage == null ? '—' : `${number(item.mileage)} км` }}</td>
                <td role="cell" data-label="Сумма">{{ item.totalAmount == null ? '—' : money(item.totalAmount) }}</td>
                <td role="cell" data-label="Файл"><a :href="`/api/service-documents/${item.id}`" target="_blank" rel="noopener">{{ item.originalName || 'файл' }}</a></td>
                <td role="cell" class="document-actions">
                  <AppButton size="small" :disabled="pending" @click="openDocument(item)">Проверить</AppButton>
                  <AppButton variant="secondary" size="small" :disabled="pending" @click="removeDocument(item.id)">Удалить</AppButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="card card--wide card--table">
        <div class="card__top"><p class="metric-label">Журнал замен</p></div>
        <p v-if="!data?.events.length" class="muted">Записей пока нет.</p>
        <div v-else class="table-wrap">
          <table role="table">
            <thead role="rowgroup"><tr role="row"><th role="columnheader">Дата</th><th role="columnheader">Пробег</th><th role="columnheader">Моточасы</th><th role="columnheader">Заметка</th><th role="columnheader" /></tr></thead>
            <tbody role="rowgroup">
              <tr v-for="item in data.events" :key="item.id" role="row">
                <td role="cell" data-label="Дата">{{ date(item.performedAt) }}</td>
                <td role="cell" data-label="Пробег">{{ number(item.mileage) }} км</td>
                <td role="cell" data-label="Моточасы">{{ hours(item.motorMinutes) }}</td>
                <td role="cell" data-label="Заметка">{{ item.note || '—' }}</td>
                <td role="cell"><AppButton variant="secondary" size="small" :disabled="pending" @click="remove(item.id)">Удалить</AppButton></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="card card--wide card--table">
        <div class="card__top">
          <div>
            <p class="metric-label">Постоянные расходы</p>
            <p class="muted">
              Страховка, налог и прочее, оплаченное за период целиком. В стоимость километра они входят теми днями,
              которыми пересеклись с месяцем, — годовой полис не ложится в август целиком
            </p>
          </div>
        </div>
        <p v-if="!data?.fixedCosts.length" class="muted">
          Записей пока нет. Километр считается только по топливу и заказ-нарядам.
        </p>
        <div v-else class="table-wrap">
          <table role="table">
            <thead role="rowgroup"><tr role="row"><th role="columnheader">Название</th><th role="columnheader">Сумма</th><th role="columnheader">Период</th><th role="columnheader">В месяц</th><th role="columnheader" /></tr></thead>
            <tbody role="rowgroup">
              <tr v-for="item in data.fixedCosts" :key="item.id" role="row">
                <td role="cell" data-label="Название">{{ item.label }}</td>
                <td role="cell" data-label="Сумма">{{ money(item.amount) }}</td>
                <td role="cell" data-label="Период">{{ date(item.startsAt) }} — {{ date(item.endsAt) }}</td>
                <td role="cell" data-label="В месяц">{{ money(monthlyShare(item)) }}</td>
                <td role="cell"><AppButton variant="secondary" size="small" :disabled="pending" @click="removeFixedCost(item.id)">Удалить</AppButton></td>
              </tr>
            </tbody>
          </table>
        </div>
        <AppForm id="fixed-cost-form" class="fixed-cost-form" @submit="addFixedCost">
          <AppField label="Название">
            <AppInput v-model="fixedCostForm.label" maxlength="80" placeholder="Например, ОСАГО" :disabled="pending" required />
          </AppField>
          <AppField label="Сумма, ₽">
            <AppInput v-model="fixedCostForm.amount" inputmode="decimal" :disabled="pending" required />
          </AppField>
          <AppField label="Оплачено с">
            <AppInput v-model="fixedCostForm.startsAt" type="date" :disabled="pending" required />
          </AppField>
          <AppField label="По" hint="Пусто — год с даты начала">
            <AppInput v-model="fixedCostForm.endsAt" type="date" :disabled="pending" />
          </AppField>
          <AppAlert v-if="fixedCostError" class="form-wide">{{ fixedCostError }}</AppAlert>
          <div class="form-wide">
            <AppButton type="submit" :disabled="pending">{{ pending ? 'Сохраняем…' : 'Добавить расход' }}</AppButton>
          </div>
        </AppForm>
      </section>
    </div>

    <AppModal
      :model-value="Boolean(editing)"
      title="Данные из акта"
      :eyebrow="editing ? date(editing.receivedAt) : ''"
      :close-on-backdrop="!pending"
      :close-on-escape="!pending"
      @update:model-value="value => { if (!value && !pending) editing = null }"
    >
      <p class="muted form-summary">{{ parseSummary }}</p>
      <AppForm id="document-form" @submit="confirmDocument">
        <AppField label="Дата работ" :hint="fieldHint('performedAt')">
          <AppInput v-model="documentForm.performedAt" type="date" required :disabled="pending" />
        </AppField>
        <AppField label="Пробег, км" :hint="fieldHint('mileage')">
          <AppInput v-model="documentForm.mileage" inputmode="numeric" :disabled="pending" />
        </AppField>
        <AppField label="Сумма, ₽" :hint="fieldHint('totalAmount')">
          <AppInput v-model="documentForm.totalAmount" inputmode="decimal" :disabled="pending" />
        </AppField>
        <AppField label="Заказ-наряд №" :hint="fieldHint('orderNumber')">
          <AppInput v-model="documentForm.orderNumber" maxlength="60" :disabled="pending" />
        </AppField>
        <AppField label="Исполнитель" wide>
          <AppInput v-model="documentForm.vendor" maxlength="120" placeholder="Например, Автосалон Глобус" :disabled="pending" />
        </AppField>
        <AppField label="Заметка" wide>
          <AppInput v-model="documentForm.note" maxlength="300" placeholder="Что делали, какое масло" :disabled="pending" />
        </AppField>
        <AppCheckbox v-model="documentForm.createOilEvent" wide :disabled="pending">
          Это замена масла — начать отсчёт ресурса с этой даты
        </AppCheckbox>
        <AppAlert v-if="documentError" wide>{{ documentError }}</AppAlert>
      </AppForm>
      <template #footer>
        <AppButton variant="secondary" :disabled="pending" @click="reparseDocument">Распознать заново</AppButton>
        <AppButton variant="secondary" :disabled="pending" @click="editing = null">Отмена</AppButton>
        <AppButton type="submit" form="document-form" :disabled="pending">{{ pending ? 'Сохраняем…' : 'Подтвердить' }}</AppButton>
      </template>
    </AppModal>
  </div>
</template>
