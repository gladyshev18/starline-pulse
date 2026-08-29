<script setup lang="ts">
import { DOUBT_LABELS, type ConsumptionDoubt } from '~~/shared/consumption-confidence'

const route = useRoute()
const page = computed(() => Math.max(1, Number(route.query.page) || 1))
const selectedDay = computed(() => {
  const value = route.query.day
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10) === value ? value : undefined
})
const { data, status, refresh } = await useFetch('/api/trips', { query: { page, day: selectedDay } })
const editingTrip = ref<{ id: number, startedAt: string | Date, comment: string | null } | null>(null)
const commentDraft = ref('')
const commentPending = ref(false)
const commentError = ref('')
const editingDriver = ref<{ id: number, startedAt: string | Date, driver: string | null } | null>(null)
const driverDraft = ref('')
const driverPending = ref(false)
const driverError = ref('')
// Имена приходят вместе с поездками: список короткий и нужен только этой
// странице, отдельный запрос за ним был бы дороже самого списка.
const driverOptions = computed(() => (data.value?.drivers ?? []).map(name => ({ value: name, label: name })))

function number(value: number | null, digits = 1) { return value == null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value) }
function date(value: string | Date) { return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) }
function day(value: string) { return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long' }).format(new Date(`${value}T00:00:00+03:00`)) }
function duration(value: number | null) {
  if (value == null) return '—'
  const minutes = Math.max(0, Math.round(value))
  if (minutes < 1) return '< 1 мин'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return `${rest} мин`
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`
}
// Датчик умеет только целые проценты бака, то есть пол-литра, и разность двух
// таких показаний тонет в округлении — половина поездок показывает ровно ноль,
// а изредка и небольшой минус. Писать «0 л» значило бы утверждать, что бензин не
// расходовался; честнее сказать, что столько датчик не различает.
function litres(value: number | null) {
  if (value == null) return '—'
  return Math.abs(value) < 0.5 ? '< 0,5 л' : `${number(value)} л`
}
function unresolved(value: number | null) {
  return value != null && Math.abs(value) < 0.5
}
// Расход одной поездки — это разность двух показаний датчика, и промахнуться
// она может на целый его шаг. На тридцати километрах это полтора литра на сотню
// и ничего не меняет, на трёх — четырнадцать, то есть половина значения. Одно и
// то же число «28 л/100 км» в этих двух случаях означает совершенно разное, и
// граница ошибки рядом с ним — единственный способ это показать.
function consumptionRange(trip: { consumption: number | null, consumptionErrorBound: number | null }) {
  const value = number(trip.consumption)
  if (trip.consumptionErrorBound == null) return `${value} л/100 км`
  return `${value} ± ${number(trip.consumptionErrorBound)} л/100 км`
}
function doubtTitle(doubts: ConsumptionDoubt[]) {
  return doubts.map(doubt => DOUBT_LABELS[doubt]).join(' · ') || undefined
}
// Копейки тут не значат ничего: цена литра сама выведена из чеков за месяц.
function money(value: number | null | undefined) {
  if (value == null) return '—'
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(value)
}
function pageLink(targetPage: number) {
  return { query: { page: targetPage, ...(selectedDay.value ? { day: selectedDay.value } : {}) } }
}
function openComment(trip: { id: number, startedAt: string | Date, comment: string | null }) {
  editingTrip.value = trip
  commentDraft.value = trip.comment || ''
  commentError.value = ''
}
function closeComment() {
  editingTrip.value = null
  commentDraft.value = ''
  commentError.value = ''
}
function errorMessage(error: unknown, fallback = 'Не удалось сохранить комментарий') {
  if (typeof error === 'object' && error) {
    const value = error as { data?: { statusMessage?: string }, statusMessage?: string }
    return value.data?.statusMessage || value.statusMessage || fallback
  }
  return fallback
}
function openDriver(trip: { id: number, startedAt: string | Date, driver: string | null }) {
  editingDriver.value = trip
  driverDraft.value = trip.driver || ''
  driverError.value = ''
}
function closeDriver() {
  editingDriver.value = null
  driverDraft.value = ''
  driverError.value = ''
}
async function saveDriver() {
  if (!editingDriver.value || driverPending.value) return
  driverPending.value = true
  driverError.value = ''
  try {
    await $fetch(`/api/trips/${editingDriver.value.id}`, { method: 'PATCH', body: { driver: driverDraft.value || null } })
    await refresh()
    closeDriver()
  } catch (error) {
    driverError.value = errorMessage(error, 'Не удалось сохранить водителя')
  } finally {
    driverPending.value = false
  }
}
async function saveComment() {
  if (!editingTrip.value || commentPending.value) return
  commentPending.value = true
  commentError.value = ''
  try {
    await $fetch(`/api/trips/${editingTrip.value.id}`, { method: 'PATCH', body: { comment: commentDraft.value } })
    await refresh()
    closeComment()
  } catch (error) {
    commentError.value = errorMessage(error)
  } finally {
    commentPending.value = false
  }
}
</script>

<template>
  <div>
    <header class="page-heading">
      <div><p class="eyebrow">История</p><h1 class="page-title">Поездки</h1></div>
    </header>
    <section class="card card--table">
      <div class="card__top">
        <div>
          <p class="metric-label">Журнал поездок</p>
          <p v-if="selectedDay" class="muted trips-filter-note">За {{ day(selectedDay) }}</p>
          <!-- Пояснение стоит один раз, а не в каждой строке: основание у всех
               поездок одно, и повторённое двадцать раз оно только распирало
               таблицу и мешало читать. -->
          <p class="muted trips-filter-note">Стоимость — километры поездки по цене километра за её месяц</p>
        </div>
        <AppButton v-if="selectedDay" variant="secondary" to="/trips">Все поездки</AppButton>
      </div>
      <p v-if="status === 'pending'">Загрузка…</p>
      <div v-else-if="!data?.items.length" class="muted">{{ selectedDay ? 'За выбранный день завершённых поездок нет.' : 'Завершённых поездок пока нет.' }}</div>
      <div v-else class="table-wrap">
        <table role="table">
          <thead role="rowgroup"><tr role="row"><th role="columnheader">Дата</th><th role="columnheader">Дальность</th><th role="columnheader">Длительность</th><th role="columnheader">Ср. скорость</th><th role="columnheader">Расход топлива</th><th role="columnheader">Стоимость</th><th role="columnheader">За рулём</th><th role="columnheader">Комментарий</th></tr></thead>
          <tbody role="rowgroup">
            <tr v-for="trip in data.items" :key="trip.id" role="row">
              <td role="cell" data-label="Дата">{{ date(trip.startedAt) }}</td>
              <td role="cell" data-label="Дальность">{{ number(trip.distance) }} км</td>
              <td role="cell" data-label="Длительность">{{ duration(trip.durationMinutes) }}</td>
              <td role="cell" data-label="Ср. скорость">{{ number(trip.averageSpeed) }} км/ч</td>
              <td role="cell" data-label="Расход топлива">
                <span class="cell-stack">
                  {{ litres(trip.fuelUsed) }}
                  <span
                    v-if="!unresolved(trip.fuelUsed)"
                    class="trip-consumption"
                    :title="doubtTitle(trip.doubts)"
                  >{{ consumptionRange(trip) }}</span>
                  <span v-else class="trip-consumption muted">ниже точности датчика</span>
                  <span v-if="trip.outlier" class="trip-flag">
                    {{ trip.deviation! > 0 ? 'Выше' : 'Ниже' }} обычного на {{ number(Math.abs(trip.deviation!)) }} л/100 км
                  </span>
                </span>
              </td>
              <td role="cell" data-label="Стоимость">{{ money(trip.cost) }}</td>
              <td role="cell" data-label="За рулём" class="trip-driver-cell">
                <button
                  class="trip-comment-button"
                  :class="{ 'trip-comment-button--empty': !trip.driver }"
                  type="button"
                  :aria-label="`Кто был за рулём в поездке ${date(trip.startedAt)}`"
                  @click="openDriver(trip)"
                >
                  {{ trip.driver || 'Указать' }}
                </button>
              </td>
              <td role="cell" data-label="Комментарий" class="trip-comment-cell">
                <button
                  class="trip-comment-button"
                  :class="{ 'trip-comment-button--empty': !trip.comment }"
                  type="button"
                  :aria-label="trip.comment ? `Редактировать комментарий к поездке ${date(trip.startedAt)}` : `Добавить комментарий к поездке ${date(trip.startedAt)}`"
                  @click="openComment(trip)"
                >
                  {{ trip.comment || 'Добавить комментарий' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <nav v-if="data && data.pages > 1" class="pagination" aria-label="Страницы поездок">
        <AppButton variant="secondary" :style="{ visibility: page > 1 ? 'visible' : 'hidden' }" :to="pageLink(page - 1)">Назад</AppButton>
        <span class="muted">{{ page }} / {{ data.pages }}</span>
        <AppButton variant="secondary" :style="{ visibility: page < data.pages ? 'visible' : 'hidden' }" :to="pageLink(page + 1)">Дальше</AppButton>
      </nav>
    </section>

    <AppModal
      :model-value="Boolean(editingDriver)"
      title="Кто был за рулём"
      :eyebrow="editingDriver ? date(editingDriver.startedAt) : ''"
      :close-on-backdrop="!driverPending"
      :close-on-escape="!driverPending"
      @update:model-value="value => { if (!value && !driverPending) closeDriver() }"
    >
      <AppForm id="trip-driver-form" layout="stack" @submit="saveDriver">
        <AppField label="За рулём">
          <AppSelect
            v-model="driverDraft"
            :options="driverOptions"
            placeholder="Не указан"
            placeholder-selectable
            :disabled="driverPending"
          />
        </AppField>
        <AppAlert v-if="driverError">{{ driverError }}</AppAlert>
      </AppForm>
      <template #footer>
        <AppButton variant="secondary" :disabled="driverPending" @click="closeDriver">Отмена</AppButton>
        <AppButton type="submit" form="trip-driver-form" :disabled="driverPending">
          {{ driverPending ? 'Сохраняем…' : 'Сохранить' }}
        </AppButton>
      </template>
    </AppModal>

    <AppModal
      :model-value="Boolean(editingTrip)"
      :title="editingTrip?.comment ? 'Редактировать комментарий' : 'Добавить комментарий'"
      :eyebrow="editingTrip ? date(editingTrip.startedAt) : ''"
      :close-on-backdrop="!commentPending"
      :close-on-escape="!commentPending"
      @update:model-value="value => { if (!value && !commentPending) closeComment() }"
    >
      <AppForm id="trip-comment-form" layout="stack" @submit="saveComment">
        <AppField label="Комментарий к поездке">
          <AppTextarea
            v-model="commentDraft"
            :maxlength="1000"
            :rows="6"
            counter
            placeholder="Например, цель поездки или важная деталь"
            :disabled="commentPending"
          />
        </AppField>
        <AppAlert v-if="commentError">{{ commentError }}</AppAlert>
      </AppForm>
      <template #footer>
        <AppButton variant="secondary" :disabled="commentPending" @click="closeComment">Отмена</AppButton>
        <AppButton type="submit" form="trip-comment-form" :disabled="commentPending">
          {{ commentPending ? 'Сохраняем…' : 'Сохранить' }}
        </AppButton>
      </template>
    </AppModal>
  </div>
</template>
