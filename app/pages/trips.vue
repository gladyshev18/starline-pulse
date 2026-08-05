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
function consumption(distance: number | null, fuel: number | null) { return distance && fuel != null ? fuel / distance * 100 : null }
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
        <NuxtLink v-if="selectedDay" class="btn btn--secondary" to="/trips">Все поездки</NuxtLink>
      </div>
      <p v-if="status === 'pending'">Загрузка…</p>
      <div v-else-if="!data?.items.length" class="muted">{{ selectedDay ? 'За выбранный день завершённых поездок нет.' : 'Завершённых поездок пока нет.' }}</div>
      <div v-else class="table-wrap">
        <table>
          <thead><tr><th>Дата</th><th>Расстояние</th><th>Топливо</th><th>Расход</th><th>Комментарий</th></tr></thead>
          <tbody>
            <tr v-for="trip in data.items" :key="trip.id">
              <td>{{ date(trip.startedAt) }}</td>
              <td>{{ number(trip.distance) }} км</td>
              <td>{{ number(trip.fuelUsed) }} л</td>
              <td>{{ number(consumption(trip.distance, trip.fuelUsed)) }} л/100 км</td>
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
        <NuxtLink class="btn btn--secondary" :style="{ visibility: page > 1 ? 'visible' : 'hidden' }" :to="pageLink(page - 1)">Назад</NuxtLink>
        <span class="muted">{{ page }} / {{ data.pages }}</span>
        <NuxtLink class="btn btn--secondary" :style="{ visibility: page < data.pages ? 'visible' : 'hidden' }" :to="pageLink(page + 1)">Дальше</NuxtLink>
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
      <form id="trip-comment-form" class="trip-comment-form" @submit.prevent="saveComment">
        <label for="trip-comment">Комментарий к поездке</label>
        <textarea
          id="trip-comment"
          v-model="commentDraft"
          maxlength="1000"
          rows="6"
          placeholder="Например, цель поездки или важная деталь"
          :disabled="commentPending"
        />
        <span class="trip-comment-counter">{{ commentDraft.length }} / 1000</span>
        <p v-if="commentError" class="error">{{ commentError }}</p>
      </form>
      <template #footer>
        <button class="btn btn--secondary" type="button" :disabled="commentPending" @click="closeComment">Отмена</button>
        <button class="btn" type="submit" form="trip-comment-form" :disabled="commentPending">
          {{ commentPending ? 'Сохраняем…' : 'Сохранить' }}
        </button>
      </template>
    </AppModal>
  </div>
</template>
