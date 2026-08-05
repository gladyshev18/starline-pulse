<script setup lang="ts">
interface ApiCallDetail {
  id: number
  day: string
  endpoint: string
  method: string
  url: string | null
  status: number
  durationMs: number | null
  requestHeaders: string | null
  requestBody: string | null
  responseHeaders: string | null
  responseBody: string | null
  error: string | null
  createdAt: string | Date
}

const page = ref(1)
const search = ref('')
const statusFilter = ref('all')
const day = ref('')
const query = computed(() => ({ page: page.value, search: search.value || undefined, status: statusFilter.value, day: day.value || undefined }))
const { data, status, refresh } = await useFetch('/api/api-logs', { query })
const selected = ref<ApiCallDetail | null>(null)
const detailPending = ref(false)
const detailsOpen = ref(false)

watch([search, statusFilter, day], () => { page.value = 1 })

async function openDetails(id: number) {
  detailPending.value = true
  try {
    selected.value = await $fetch<ApiCallDetail>(['/api/api-logs', id].join('/'))
    detailsOpen.value = true
  }
  finally { detailPending.value = false }
}

function clearClosedDetails() {
  if (!detailsOpen.value) selected.value = null
}

function date(value: string | Date) {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value))
}

function statusLabel(value: number) {
  if (value === 0) return 'Нет ответа'
  return String(value)
}

function bodyLabel(value: string | null) { return value || 'Тело отсутствует' }
</script>

<template>
  <div>
    <header class="page-heading api-heading">
      <div><p class="eyebrow">Диагностика</p><h1 class="page-title">Журнал API</h1></div>
      <button class="btn btn--secondary" type="button" :disabled="status === 'pending'" @click="refresh()">Обновить</button>
    </header>

    <section class="card card--table">
      <div class="log-filters">
        <label class="field"><span>Поиск по адресу</span><input v-model.trim="search" type="search" placeholder="/json/v3/device…"></label>
        <label class="field"><span>Результат</span><select v-model="statusFilter"><option value="all">Все</option><option value="success">Успешные</option><option value="error">С ошибкой</option></select></label>
        <label class="field"><span>Дата</span><input v-model="day" type="date"></label>
      </div>

      <p v-if="status === 'pending'" class="muted">Загрузка журнала…</p>
      <p v-else-if="!data?.items.length" class="muted">По выбранным условиям записей нет.</p>
      <div v-else class="table-wrap">
        <table class="log-table">
          <thead><tr><th>Время</th><th>Метод</th><th>Endpoint</th><th>Статус</th><th>Время ответа</th><th></th></tr></thead>
          <tbody>
            <tr v-for="item in data.items" :key="item.id" :class="{ 'is-selected': selected?.id === item.id }">
              <td>{{ date(item.createdAt) }}</td>
              <td><span class="method-badge">{{ item.method }}</span></td>
              <td class="endpoint-cell">{{ item.endpoint }}</td>
              <td><span class="status-badge" :class="item.status >= 200 && item.status < 400 ? 'status-badge--ok' : 'status-badge--error'">{{ statusLabel(item.status) }}</span></td>
              <td>{{ item.durationMs == null ? '—' : `${item.durationMs} мс` }}</td>
              <td><button class="log-open" type="button" :disabled="detailPending" @click="openDetails(item.id)">Детали</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <nav v-if="data && data.pages > 1" class="pagination" aria-label="Страницы журнала API">
        <button class="btn btn--secondary" type="button" :disabled="page <= 1" @click="page--">Назад</button>
        <span class="muted">{{ page }} / {{ data.pages }} · записей: {{ data.total }}</span>
        <button class="btn btn--secondary" type="button" :disabled="page >= data.pages" @click="page++">Дальше</button>
      </nav>
    </section>

    <AppModal
      v-if="selected"
      v-model="detailsOpen"
      :title="`${selected.method} ${selected.endpoint}`"
      :eyebrow="`Запись № ${selected.id}`"
      size="large"
      @after-close="clearClosedDetails"
    >
      <div class="log-details">
        <dl class="log-meta">
          <div><dt>Время</dt><dd>{{ date(selected.createdAt) }}</dd></div>
          <div><dt>Статус</dt><dd>{{ statusLabel(selected.status) }}</dd></div>
          <div><dt>Длительность</dt><dd>{{ selected.durationMs == null ? '—' : `${selected.durationMs} мс` }}</dd></div>
          <div class="log-meta__url"><dt>URL</dt><dd>{{ selected.url || selected.endpoint }}</dd></div>
        </dl>
        <p v-if="selected.error" class="error">{{ selected.error }}</p>
        <div class="payload-grid">
          <details open><summary>Запрос — заголовки</summary><pre>{{ bodyLabel(selected.requestHeaders) }}</pre></details>
          <details open><summary>Ответ — заголовки</summary><pre>{{ bodyLabel(selected.responseHeaders) }}</pre></details>
          <details open><summary>Запрос — данные</summary><pre>{{ bodyLabel(selected.requestBody) }}</pre></details>
          <details open><summary>Ответ — данные</summary><pre>{{ bodyLabel(selected.responseBody) }}</pre></details>
        </div>
        <p class="privacy-note">Значения секретов, токенов, cookie, логинов и паролей автоматически заменяются на «[СКРЫТО]».</p>
      </div>
    </AppModal>
  </div>
</template>
