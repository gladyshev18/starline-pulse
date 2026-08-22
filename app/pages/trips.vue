<script setup lang="ts">
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
function errorMessage(error: unknown) {
  if (typeof error === 'object' && error) {
    const value = error as { data?: { statusMessage?: string }, statusMessage?: string }
    return value.data?.statusMessage || value.statusMessage || 'Не удалось сохранить комментарий'
  }
  return 'Не удалось сохранить комментарий'
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
        </div>
        <AppButton v-if="selectedDay" variant="secondary" to="/trips">Все поездки</AppButton>
      </div>
      <p v-if="status === 'pending'">Загрузка…</p>
      <div v-else-if="!data?.items.length" class="muted">{{ selectedDay ? 'За выбранный день завершённых поездок нет.' : 'Завершённых поездок пока нет.' }}</div>
      <div v-else class="table-wrap">
        <table>
          <thead><tr><th>Дата</th><th>Дальность</th><th>Длительность</th><th>Ср. скорость</th><th>Расход топлива</th><th>За рулём</th><th>Комментарий</th></tr></thead>
          <tbody>
            <tr v-for="trip in data.items" :key="trip.id">
              <td>{{ date(trip.startedAt) }}</td>
              <td>{{ number(trip.distance) }} км</td>
              <td>{{ duration(trip.durationMinutes) }}</td>
              <td>{{ number(trip.averageSpeed) }} км/ч</td>
              <td>
                {{ number(trip.fuelUsed) }} л
                <span class="trip-consumption">{{ number(trip.consumption) }} л/100 км</span>
              </td>
              <td :class="{ muted: !trip.driver }">{{ trip.driver || '—' }}</td>
              <td class="trip-comment-cell">
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
