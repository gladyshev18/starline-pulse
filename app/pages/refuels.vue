<script setup lang="ts">
const MAX_FILE_SIZE = 15 * 1024 * 1024
const { data, status, refresh } = await useFetch('/api/refuels')
const uploading = reactive<Record<number, boolean>>({})
const errors = reactive<Record<number, string>>({})
const editingRefuel = ref<{
  id: number
  detectedAt: string | Date
  litresAdded: number | null
  station: 'rosneft' | 'lukoil' | 'other' | null
  stationName: string | null
  fuelType: string | null
  pricePerLitre: number | null
  totalAmount: number | null
} | null>(null)
const detailsPending = ref(false)
const detailsError = ref('')
// The gauge reads in half litres, so one refuel disagreeing with its receipt by
// exactly that is rounding. Only the average over several of them is the sensor.
const driftHeadline = computed(() => {
  const drift = data.value?.drift
  if (!drift || drift.bias == null) return 'Пока не с чем сравнивать'
  const direction = drift.bias > 0 ? 'завышает' : drift.bias < 0 ? 'занижает' : 'совпадает с чеками'
  if (drift.bias === 0) return 'Совпадает с чеками'
  return `Датчик ${direction} на ${number(Math.abs(drift.bias), 2)} л`
})
const driftNote = computed(() => {
  const drift = data.value?.drift
  if (!drift) return ''
  const parts: string[] = []
  if (drift.samples) parts.push(`${drift.samples} заправок с чеком`)
  if (drift.uncertainty != null) parts.push(`± ${number(drift.uncertainty, 2)} л`)
  if (drift.saturated) parts.push(`${drift.saturated} до полного бака не в счёт — датчик упирается в 100 %`)
  if (!drift.systematic && drift.samples) parts.push('для поправки этого мало: расхождение пока в пределах округления')
  return parts.join(' · ')
})
const details = reactive({ station: '', stationName: '', fuelType: '', pricePerLitre: '', totalAmount: '' })

function number(value: number | null, digits = 1) {
  return value == null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value)
}

function date(value: string | Date) {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(value))
}

function money(value: number | null) {
  return value == null ? '—' : new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(value)
}

function fileSize(value: number) {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} КБ`
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value / 1024 / 1024)} МБ`
}

function receiptKind(mimeType: string | null) {
  if (mimeType === 'application/pdf') return 'PDF'
  if (mimeType === 'text/html') return 'HTML'
  return mimeType ? 'Изображение' : 'Без файла'
}

// Under half a litre the sensor simply agrees with the receipt, and saying so
// on every card would be noise.
function discrepancy(value: number | null) {
  return value != null && Math.abs(value) >= 0.5
}

const receiptOrigin: Record<string, string> = {
  manual: 'добавлен вручную',
  imap: 'получен по почте',
  telegram: 'прислан в Telegram'
}

function errorMessage(error: unknown, fallback = 'Не удалось выполнить запрос') {
  if (typeof error === 'object' && error) {
    const value = error as { data?: { statusMessage?: string }, statusMessage?: string }
    return value.data?.statusMessage || value.statusMessage || fallback
  }
  return fallback
}

function openDetails(refuel: NonNullable<typeof editingRefuel.value>) {
  editingRefuel.value = refuel
  details.station = refuel.station || ''
  details.stationName = refuel.stationName || ''
  details.fuelType = refuel.fuelType || ''
  details.pricePerLitre = refuel.pricePerLitre?.toString() || ''
  details.totalAmount = refuel.totalAmount?.toString() || ''
  detailsError.value = ''
}

function closeDetails() {
  editingRefuel.value = null
  detailsError.value = ''
}

function amount(value: string) {
  const parsed = Number(value.replace(',', '.'))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

// Whichever of the two you have, the volume from the sensor gives the other:
// receipts often print only the total, and the price then follows from it.
function completeAmounts() {
  const litres = editingRefuel.value?.litresAdded
  if (litres == null || litres <= 0) return
  const price = amount(details.pricePerLitre)
  const total = amount(details.totalAmount)
  if (price != null && total == null) details.totalAmount = (litres * price).toFixed(2)
  else if (total != null && price == null) details.pricePerLitre = (total / litres).toFixed(2)
}

const canCompleteAmounts = computed(() => {
  const litres = editingRefuel.value?.litresAdded
  if (litres == null || litres <= 0) return false
  const filled = [details.pricePerLitre, details.totalAmount].filter(value => amount(value) != null)
  return filled.length === 1
})

async function saveDetails() {
  if (!editingRefuel.value || detailsPending.value) return
  detailsPending.value = true
  detailsError.value = ''
  try {
    await $fetch(`/api/refuels/${editingRefuel.value.id}`, {
      method: 'PATCH',
      body: {
        station: details.station,
        stationName: details.stationName,
        fuelType: details.fuelType,
        pricePerLitre: details.pricePerLitre,
        totalAmount: details.totalAmount
      }
    })
    await refresh()
    closeDetails()
  } catch (error) {
    detailsError.value = errorMessage(error, 'Не удалось сохранить данные заправки')
  } finally {
    detailsPending.value = false
  }
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
    errors[refuelId] = errorMessage(error, 'Не удалось прикрепить чек')
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
      <section v-if="data.drift.samples || data.drift.saturated" class="card card--wide">
        <div class="card__top">
          <p class="metric-label">Точность датчика</p>
          <span v-if="data.drift.systematic" class="metric-badge">систематическое</span>
        </div>
        <p class="metric metric--compact">{{ driftHeadline }}</p>
        <p class="muted">{{ driftNote }}</p>
      </section>
      <article v-for="refuel in data.items" :key="refuel.id" class="card refuel-card">
        <div class="refuel-card__summary">
          <div>
            <div class="refuel-card__top">
              <p class="eyebrow">{{ date(refuel.detectedAt) }}</p>
              <button class="refuel-edit" type="button" @click="openDetails(refuel)">{{ refuel.station ? 'Изменить' : 'Добавить данные' }}</button>
            </div>
            <div class="refuel-flags">
              <span class="confirm-badge" :class="refuel.confirmed ? 'confirm-badge--ok' : 'confirm-badge--pending'">
                {{ refuel.confirmed ? 'Подтверждена чеком' : 'Чек не привязан' }}
              </span>
              <span v-if="discrepancy(refuel.sensorDrift)" class="confirm-badge confirm-badge--warn">
                Датчик показывал {{ number(refuel.sensorLitresAdded) }} л
              </span>
            </div>
            <RefuelStationBadge v-if="refuel.station" :station="refuel.station" :name="refuel.stationName" />
            <p class="refuel-card__amount">+{{ number(refuel.litresAdded) }} <small>л</small></p>
          </div>
          <dl class="refuel-meta">
            <div><dt>Пробег</dt><dd>{{ number(refuel.mileage) }} км</dd></div>
            <div><dt>Уровень</dt><dd>{{ number(refuel.percentBefore, 0) }} → {{ number(refuel.percentAfter, 0) }}%</dd></div>
            <div><dt>Топливо</dt><dd>{{ number(refuel.fuelBefore) }} → {{ number(refuel.fuelAfter) }} л</dd></div>
            <div><dt>Вид топлива</dt><dd>{{ refuel.fuelType || '—' }}</dd></div>
            <div><dt>Цена за литр</dt><dd>{{ money(refuel.pricePerLitre) }}</dd></div>
            <div><dt>Сумма</dt><dd>{{ money(refuel.totalAmount) }}</dd></div>
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
              <component
                :is="receipt.storedName ? 'a' : 'div'"
                :href="receipt.storedName ? `/api/refuel-receipts/${receipt.id}` : undefined"
                class="receipt-file"
                :class="{ 'receipt-file--plain': !receipt.storedName }"
              >
                <span class="receipt-file__type">{{ receiptKind(receipt.mimeType) }}</span>
                <span class="receipt-file__copy">
                  <strong>{{ receipt.originalName || money(receipt.totalAmount) }}</strong>
                  <small>
                    <template v-if="receipt.size">{{ fileSize(receipt.size) }} · </template>{{ receiptOrigin[receipt.source] || receipt.source }}
                  </small>
                </span>
                <span v-if="receipt.storedName" class="receipt-file__action">Скачать</span>
              </component>
            </li>
          </ul>
        </div>
      </article>
    </div>

    <AppModal
      :model-value="Boolean(editingRefuel)"
      title="Данные заправки"
      :eyebrow="editingRefuel ? date(editingRefuel.detectedAt) : ''"
      :close-on-backdrop="!detailsPending"
      :close-on-escape="!detailsPending"
      @update:model-value="value => { if (!value && !detailsPending) closeDetails() }"
    >
      <form id="refuel-details-form" class="refuel-details-form" @submit.prevent="saveDetails">
        <label class="field">
          <span>АЗС</span>
          <select v-model="details.station" required :disabled="detailsPending">
            <option value="" disabled>Выберите АЗС</option>
            <option value="rosneft">Роснефть</option>
            <option value="lukoil">Лукойл</option>
            <option value="other">Другая АЗС</option>
          </select>
        </label>
        <label v-if="details.station === 'other'" class="field refuel-details-form__wide">
          <span>Название АЗС</span>
          <input v-model="details.stationName" required maxlength="100" placeholder="Введите название">
        </label>
        <label class="field refuel-details-form__wide">
          <span>Вид топлива</span>
          <input v-model="details.fuelType" required maxlength="50" list="fuel-types" placeholder="Например, АИ-95">
          <datalist id="fuel-types">
            <option value="АИ-92" />
            <option value="АИ-95" />
            <option value="АИ-95 Премиум" />
            <option value="АИ-98" />
            <option value="АИ-100" />
          </datalist>
        </label>
        <label class="field">
          <span>Цена за литр, ₽</span>
          <input v-model="details.pricePerLitre" type="number" min="0.01" max="10000" step="0.01" inputmode="decimal" placeholder="65,50" @change="completeAmounts">
        </label>
        <label class="field">
          <span>Сумма, ₽</span>
          <input v-model="details.totalAmount" type="number" min="0.01" max="10000000" step="0.01" inputmode="decimal" placeholder="2500,00" @change="completeAmounts">
        </label>
        <button class="refuel-calculate" type="button" :disabled="detailsPending || !canCompleteAmounts" @click="completeAmounts">
          Достроить второе значение по объёму {{ number(editingRefuel?.litresAdded || null) }} л
        </button>
        <p class="muted refuel-details-form__wide receipt-hint">Достаточно заполнить сумму или цену — второе посчитается по объёму заправки.</p>
        <p v-if="detailsError" class="error refuel-details-form__wide">{{ detailsError }}</p>
      </form>
      <template #footer>
        <button class="btn btn--secondary" type="button" :disabled="detailsPending" @click="closeDetails">Отмена</button>
        <button class="btn" type="submit" form="refuel-details-form" :disabled="detailsPending">{{ detailsPending ? 'Сохраняем…' : 'Сохранить' }}</button>
      </template>
    </AppModal>
  </div>
</template>
