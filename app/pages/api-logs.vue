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
const query = computed(() => ({ page: page.value, search: search.value.trim() || undefined, status: statusFilter.value, day: day.value || undefined }))
const statusOptions = [
  { value: 'all', label: 'Все' },
  { value: 'success', label: 'Успешные' },
  { value: 'error', label: 'С ошибкой' }
]
const { data, status, refresh } = await useFetch('/api/api-logs', { query })
const selected = ref<ApiCallDetail | null>(null)
const detailPending = ref(false)
const detailsOpen = ref(false)
const copiedField = ref<string | null>(null)
const copyMessage = ref('')
let copyTimer: ReturnType<typeof setTimeout> | undefined

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

function number(value: number | null | undefined) {
  return value == null ? '—' : new Intl.NumberFormat('ru-RU').format(value)
}

function statusLabel(value: number) {
  if (value === 0) return 'Нет ответа'
  return String(value)
}

function bodyLabel(value: string | null) { return value || 'Тело отсутствует' }

function durationLabel(value: number | null) { return value == null ? '—' : `${value} мс` }

async function writeClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch {
      // Fallback supports non-secure local environments and older browsers.
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('Clipboard API is unavailable')
}

async function copyData(value: string, field: string) {
  if (!import.meta.client) return
  try {
    await writeClipboard(value)
    copiedField.value = field
    copyMessage.value = 'Данные скопированы'
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copiedField.value = null
      copyMessage.value = ''
    }, 1800)
  } catch {
    copiedField.value = null
    copyMessage.value = 'Не удалось скопировать данные'
  }
}

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer)
})
</script>

<template>
  <div>
    <header class="page-heading api-heading">
      <div><p class="eyebrow">Диагностика</p><h1 class="page-title">Журнал API</h1></div>
      <AppButton variant="secondary" :disabled="status === 'pending'" @click="refresh()">Обновить</AppButton>
    </header>

    <section class="card api-limit">
      <div class="card__top"><p class="metric-label">Лимит API на сегодня</p></div>
      <p class="metric metric--compact">{{ number(data?.limit.remaining) }} <small>доступно</small></p>
      <p class="muted">{{ number(data?.limit.used) }} из 1000 использовано</p>
    </section>

    <section class="card card--table">
      <div class="log-filters">
        <AppField label="Поиск по адресу"><AppInput v-model="search" type="search" placeholder="/json/v3/device…" /></AppField>
        <AppField label="Результат"><AppSelect v-model="statusFilter" :options="statusOptions" /></AppField>
        <AppField label="Дата"><AppInput v-model="day" type="date" /></AppField>
      </div>

      <p v-if="status === 'pending'" class="muted">Загрузка журнала…</p>
      <p v-else-if="!data?.items.length" class="muted">По выбранным условиям записей нет.</p>
      <div v-else class="table-wrap">
        <table class="log-table" role="table">
          <thead role="rowgroup"><tr role="row"><th role="columnheader">Время</th><th role="columnheader">Метод</th><th role="columnheader">Endpoint</th><th role="columnheader">Статус</th><th role="columnheader">Время ответа</th><th role="columnheader"></th></tr></thead>
          <tbody role="rowgroup">
            <tr v-for="item in data.items" :key="item.id" role="row" :class="{ 'is-selected': selected?.id === item.id }">
              <td role="cell" data-label="Время">{{ date(item.createdAt) }}</td>
              <td role="cell" data-label="Метод"><span class="method-badge">{{ item.method }}</span></td>
              <td role="cell" data-label="Endpoint" class="endpoint-cell">{{ item.endpoint }}</td>
              <td role="cell" data-label="Статус"><span class="status-badge" :class="item.status >= 200 && item.status < 400 ? 'status-badge--ok' : 'status-badge--error'">{{ statusLabel(item.status) }}</span></td>
              <td role="cell" data-label="Время ответа">{{ item.durationMs == null ? '—' : `${item.durationMs} мс` }}</td>
              <td role="cell"><AppButton variant="link" :disabled="detailPending" @click="openDetails(item.id)">Детали</AppButton></td>
            </tr>
          </tbody>
        </table>
      </div>
      <nav v-if="data && data.pages > 1" class="pagination" aria-label="Страницы журнала API">
        <AppButton variant="secondary" :disabled="page <= 1" @click="page--">Назад</AppButton>
        <span class="muted">{{ page }} / {{ data.pages }} · записей: {{ data.total }}</span>
        <AppButton variant="secondary" :disabled="page >= data.pages" @click="page++">Дальше</AppButton>
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
          <div
            class="copyable-card"
            role="button"
            tabindex="0"
            aria-label="Скопировать время"
            @click="copyData(date(selected.createdAt), 'createdAt')"
            @keydown.enter.prevent="copyData(date(selected.createdAt), 'createdAt')"
            @keydown.space.prevent="copyData(date(selected.createdAt), 'createdAt')"
          >
            <dt>Время</dt><dd>{{ date(selected.createdAt) }}</dd>
            <span class="copy-indicator">{{ copiedField === 'createdAt' ? 'Скопировано' : 'Копировать' }}</span>
          </div>
          <div
            class="copyable-card"
            role="button"
            tabindex="0"
            aria-label="Скопировать статус"
            @click="copyData(statusLabel(selected.status), 'status')"
            @keydown.enter.prevent="copyData(statusLabel(selected.status), 'status')"
            @keydown.space.prevent="copyData(statusLabel(selected.status), 'status')"
          >
            <dt>Статус</dt><dd>{{ statusLabel(selected.status) }}</dd>
            <span class="copy-indicator">{{ copiedField === 'status' ? 'Скопировано' : 'Копировать' }}</span>
          </div>
          <div
            class="copyable-card"
            role="button"
            tabindex="0"
            aria-label="Скопировать длительность"
            @click="copyData(durationLabel(selected.durationMs), 'duration')"
            @keydown.enter.prevent="copyData(durationLabel(selected.durationMs), 'duration')"
            @keydown.space.prevent="copyData(durationLabel(selected.durationMs), 'duration')"
          >
            <dt>Длительность</dt><dd>{{ durationLabel(selected.durationMs) }}</dd>
            <span class="copy-indicator">{{ copiedField === 'duration' ? 'Скопировано' : 'Копировать' }}</span>
          </div>
          <div
            class="log-meta__url copyable-card"
            role="button"
            tabindex="0"
            aria-label="Скопировать URL"
            @click="copyData(selected.url || selected.endpoint, 'url')"
            @keydown.enter.prevent="copyData(selected.url || selected.endpoint, 'url')"
            @keydown.space.prevent="copyData(selected.url || selected.endpoint, 'url')"
          >
            <dt>URL</dt><dd>{{ selected.url || selected.endpoint }}</dd>
            <span class="copy-indicator">{{ copiedField === 'url' ? 'Скопировано' : 'Копировать' }}</span>
          </div>
        </dl>
        <AppAlert v-if="selected.error">{{ selected.error }}</AppAlert>
        <div class="payload-grid">
          <details open>
            <summary>Запрос — заголовки</summary>
            <pre
              class="copyable-data"
              role="button"
              tabindex="0"
              aria-label="Скопировать заголовки запроса"
              @click="copyData(bodyLabel(selected.requestHeaders), 'requestHeaders')"
              @keydown.enter.prevent="copyData(bodyLabel(selected.requestHeaders), 'requestHeaders')"
              @keydown.space.prevent="copyData(bodyLabel(selected.requestHeaders), 'requestHeaders')"
            ><span class="copy-indicator">{{ copiedField === 'requestHeaders' ? 'Скопировано' : 'Копировать' }}</span><code>{{ bodyLabel(selected.requestHeaders) }}</code></pre>
          </details>
          <details open>
            <summary>Ответ — заголовки</summary>
            <pre
              class="copyable-data"
              role="button"
              tabindex="0"
              aria-label="Скопировать заголовки ответа"
              @click="copyData(bodyLabel(selected.responseHeaders), 'responseHeaders')"
              @keydown.enter.prevent="copyData(bodyLabel(selected.responseHeaders), 'responseHeaders')"
              @keydown.space.prevent="copyData(bodyLabel(selected.responseHeaders), 'responseHeaders')"
            ><span class="copy-indicator">{{ copiedField === 'responseHeaders' ? 'Скопировано' : 'Копировать' }}</span><code>{{ bodyLabel(selected.responseHeaders) }}</code></pre>
          </details>
          <details open>
            <summary>Запрос — данные</summary>
            <pre
              class="copyable-data"
              role="button"
              tabindex="0"
              aria-label="Скопировать данные запроса"
              @click="copyData(bodyLabel(selected.requestBody), 'requestBody')"
              @keydown.enter.prevent="copyData(bodyLabel(selected.requestBody), 'requestBody')"
              @keydown.space.prevent="copyData(bodyLabel(selected.requestBody), 'requestBody')"
            ><span class="copy-indicator">{{ copiedField === 'requestBody' ? 'Скопировано' : 'Копировать' }}</span><code>{{ bodyLabel(selected.requestBody) }}</code></pre>
          </details>
          <details open>
            <summary>Ответ — данные</summary>
            <pre
              class="copyable-data"
              role="button"
              tabindex="0"
              aria-label="Скопировать данные ответа"
              @click="copyData(bodyLabel(selected.responseBody), 'responseBody')"
              @keydown.enter.prevent="copyData(bodyLabel(selected.responseBody), 'responseBody')"
              @keydown.space.prevent="copyData(bodyLabel(selected.responseBody), 'responseBody')"
            ><span class="copy-indicator">{{ copiedField === 'responseBody' ? 'Скопировано' : 'Копировать' }}</span><code>{{ bodyLabel(selected.responseBody) }}</code></pre>
          </details>
        </div>
        <p class="copy-hint">Нажмите на значение или блок данных, чтобы скопировать.</p>
        <p class="privacy-note">Значения секретов, токенов, cookie, логинов и паролей автоматически заменяются на «[СКРЫТО]».</p>
        <p class="visually-hidden" role="status" aria-live="polite">{{ copyMessage }}</p>
      </div>
    </AppModal>
  </div>
</template>
