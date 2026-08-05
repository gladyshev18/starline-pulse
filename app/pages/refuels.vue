<script setup lang="ts">
const MAX_FILE_SIZE = 15 * 1024 * 1024
const { data, status, refresh } = await useFetch('/api/refuels')
const uploading = reactive<Record<number, boolean>>({})
const errors = reactive<Record<number, string>>({})

function number(value: number | null, digits = 1) {
  return value == null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value)
}

function date(value: string | Date) {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(value))
}

function fileSize(value: number) {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} КБ`
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value / 1024 / 1024)} МБ`
}

function receiptKind(mimeType: string) {
  if (mimeType === 'application/pdf') return 'PDF'
  if (mimeType === 'text/html') return 'HTML'
  return 'Изображение'
}

function errorMessage(error: unknown) {
  if (typeof error === 'object' && error) {
    const value = error as { data?: { statusMessage?: string }, statusMessage?: string }
    return value.data?.statusMessage || value.statusMessage || 'Не удалось прикрепить чек'
  }
  return 'Не удалось прикрепить чек'
}

async function uploadReceipt(refuelId: number, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  errors[refuelId] = ''
  if (file.size > MAX_FILE_SIZE) {
    errors[refuelId] = 'Файл больше 15 МБ'
    return
  }

  const body = new FormData()
  body.append('file', file)
  uploading[refuelId] = true
  try {
    await $fetch(`/api/refuels/${refuelId}/receipts`, { method: 'POST', body })
    await refresh()
  } catch (error) {
    errors[refuelId] = errorMessage(error)
  } finally {
    uploading[refuelId] = false
  }
}
</script>

<template>
  <div>
    <header class="page-heading refuels-heading">
      <div>
        <p class="eyebrow">Топливо и документы</p>
        <h1 class="page-title">Заправки</h1>
      </div>
      <p class="refuels-heading__note">Чеки хранятся без распознавания содержимого</p>
    </header>

    <p v-if="status === 'pending'" class="muted">Загрузка…</p>
    <section v-else-if="!data?.items.length" class="card card--wide refuels-empty">
      <p class="metric-label">История заправок</p>
      <p class="muted">Заправки пока не обнаружены. Они появятся здесь после увеличения уровня топлива.</p>
    </section>
    <div v-else class="refuel-list">
      <article v-for="refuel in data.items" :key="refuel.id" class="card refuel-card">
        <div class="refuel-card__summary">
          <div>
            <p class="eyebrow">{{ date(refuel.detectedAt) }}</p>
            <p class="refuel-card__amount">+{{ number(refuel.litresAdded) }} <small>л</small></p>
          </div>
          <dl class="refuel-meta">
            <div><dt>Пробег</dt><dd>{{ number(refuel.mileage) }} км</dd></div>
            <div><dt>Уровень</dt><dd>{{ number(refuel.percentBefore, 0) }} → {{ number(refuel.percentAfter, 0) }}%</dd></div>
            <div><dt>Топливо</dt><dd>{{ number(refuel.fuelBefore) }} → {{ number(refuel.fuelAfter) }} л</dd></div>
          </dl>
        </div>

        <div class="receipt-panel">
          <div class="receipt-panel__top">
            <div>
              <p class="metric-label">Чеки</p>
              <p class="receipt-panel__hint">Изображение, PDF или HTML · до 15 МБ</p>
            </div>
            <label class="btn btn--secondary receipt-upload" :class="{ 'receipt-upload--busy': uploading[refuel.id] }">
              {{ uploading[refuel.id] ? 'Загрузка…' : 'Прикрепить файл' }}
              <input
                type="file"
                accept=".jpg,.jpeg,.png,.gif,.webp,.avif,.heic,.heif,.pdf,.html,.htm"
                :disabled="uploading[refuel.id]"
                @change="uploadReceipt(refuel.id, $event)"
              >
            </label>
          </div>

          <p v-if="errors[refuel.id]" class="error">{{ errors[refuel.id] }}</p>
          <p v-if="!refuel.receipts.length" class="muted receipt-empty">Нет прикреплённых чеков.</p>
          <ul v-else class="receipt-list">
            <li v-for="receipt in refuel.receipts" :key="receipt.id">
              <a :href="`/api/refuel-receipts/${receipt.id}`" class="receipt-file">
                <span class="receipt-file__type">{{ receiptKind(receipt.mimeType) }}</span>
                <span class="receipt-file__copy">
                  <strong>{{ receipt.originalName }}</strong>
                  <small>{{ fileSize(receipt.size) }} · {{ receipt.source === 'manual' ? 'добавлен вручную' : 'получен по почте' }}</small>
                </span>
                <span class="receipt-file__action">Скачать</span>
              </a>
            </li>
          </ul>
        </div>
      </article>
    </div>
  </div>
</template>
