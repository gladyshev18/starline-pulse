<script setup lang="ts">
const MAX_FILE_SIZE = 15 * 1024 * 1024

const filter = ref<'pending' | 'linked' | 'all'>('pending')
const { data, status, refresh } = await useFetch('/api/receipts', {
  query: { status: filter }
})
const { data: refuelsData, refresh: refreshRefuels } = await useFetch('/api/refuels')

const busy = reactive<Record<number, boolean>>({})
const rowError = reactive<Record<number, string>>({})
const editing = ref<{ id: number, title: string } | null>(null)
const creating = ref(false)
const formPending = ref(false)
const formError = ref('')
const attachment = ref<File | null>(null)
const form = reactive({
  purchasedAt: '',
  station: '',
  stationName: '',
  fuelType: '',
  litres: '',
  pricePerLitre: '',
  totalAmount: '',
  paymentMethod: 'cash',
  address: ''
})

type Receipt = NonNullable<typeof data.value>['items'][number]

const filters = [
  { value: 'pending', label: 'Ждут привязки' },
  { value: 'linked', label: 'Привязанные' },
  { value: 'all', label: 'Все' }
] as const

const statusLabels: Record<string, string> = {
  unmatched: 'Заправка не найдена',
  suggested: 'Есть предположение',
  auto: 'Привязан автоматически',
  manual: 'Привязан вручную',
  rejected: 'Отклонён'
}

const originLabels: Record<string, string> = {
  manual: 'добавлен вручную',
  imap: 'получен по почте',
  telegram: 'прислан в Telegram'
}

function number(value: number | null | undefined, digits = 1) {
  return value == null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value)
}

function money(value: number | null | undefined) {
  return value == null ? '—' : new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(value)
}

function date(value: string | Date | null) {
  return value == null ? '—' : new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(value))
}

function shortDate(value: string | Date | null) {
  return value == null ? '—' : new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

function toLocalInput(value: string | Date | null) {
  if (!value) return ''
  const moment = new Date(value)
  const shifted = new Date(moment.getTime() - moment.getTimezoneOffset() * 60_000)
  return shifted.toISOString().slice(0, 16)
}

function errorMessage(error: unknown, fallback = 'Не удалось выполнить запрос') {
  if (typeof error === 'object' && error) {
    const value = error as { data?: { statusMessage?: string }, statusMessage?: string }
    return value.data?.statusMessage || value.statusMessage || fallback
  }
  return fallback
}

function receiptTitle(receipt: Receipt) {
  return receipt.totalAmount != null ? money(receipt.totalAmount) : receipt.originalName || 'Чек без суммы'
}

function resetForm() {
  form.purchasedAt = toLocalInput(new Date())
  form.station = ''
  form.stationName = ''
  form.fuelType = ''
  form.litres = ''
  form.pricePerLitre = ''
  form.totalAmount = ''
  form.paymentMethod = 'cash'
  form.address = ''
  attachment.value = null
  formError.value = ''
}

function openCreate() {
  resetForm()
  editing.value = null
  creating.value = true
}

function openEdit(receipt: Receipt) {
  form.purchasedAt = toLocalInput(receipt.purchasedAt)
  form.station = receipt.station || ''
  form.stationName = receipt.stationName || ''
  form.fuelType = receipt.fuelType || ''
  form.litres = receipt.litres?.toString() || ''
  form.pricePerLitre = receipt.pricePerLitre?.toString() || ''
  form.totalAmount = receipt.totalAmount?.toString() || ''
  form.paymentMethod = receipt.paymentMethod || 'unknown'
  form.address = receipt.address || ''
  attachment.value = null
  formError.value = ''
  creating.value = false
  editing.value = { id: receipt.id, title: receiptTitle(receipt) }
}

function closeForm() {
  creating.value = false
  editing.value = null
  formError.value = ''
}

function pickFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] || null
  if (file && file.size > MAX_FILE_SIZE) {
    formError.value = 'Файл больше 15 МБ'
    input.value = ''
    return
  }
  formError.value = ''
  attachment.value = file
}

function amount(value: string) {
  const parsed = Number(value.replace(',', '.'))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

// Any two of volume, price and total give the third. The server does the same on
// save; doing it here as well means the figure appears while you are still typing.
function completeAmounts() {
  const litres = amount(form.litres)
  const price = amount(form.pricePerLitre)
  const total = amount(form.totalAmount)
  if (litres != null && price != null && total == null) form.totalAmount = (litres * price).toFixed(2)
  else if (total != null && price != null && litres == null) form.litres = (total / price).toFixed(2)
  else if (total != null && litres != null && price == null) form.pricePerLitre = (total / litres).toFixed(2)
}

function formBody() {
  return {
    purchasedAt: form.purchasedAt ? new Date(form.purchasedAt).toISOString() : '',
    station: form.station,
    stationName: form.stationName,
    fuelType: form.fuelType,
    litres: form.litres,
    pricePerLitre: form.pricePerLitre,
    totalAmount: form.totalAmount,
    paymentMethod: form.paymentMethod,
    address: form.address
  }
}

async function submitForm() {
  if (formPending.value) return
  formPending.value = true
  formError.value = ''
  try {
    if (editing.value) {
      await $fetch(`/api/receipts/${editing.value.id}`, { method: 'PATCH', body: formBody() })
    } else {
      const body = new FormData()
      for (const [key, value] of Object.entries(formBody())) body.append(key, value)
      if (attachment.value) body.append('file', attachment.value)
      await $fetch('/api/receipts', { method: 'POST', body })
    }
    await Promise.all([refresh(), refreshRefuels()])
    closeForm()
  } catch (error) {
    formError.value = errorMessage(error, 'Не удалось сохранить чек')
  } finally {
    formPending.value = false
  }
}

async function act(receipt: Receipt, body: Record<string, unknown>) {
  if (busy[receipt.id]) return
  busy[receipt.id] = true
  rowError[receipt.id] = ''
  try {
    await $fetch(`/api/receipts/${receipt.id}/match`, { method: 'POST', body })
    await Promise.all([refresh(), refreshRefuels()])
  } catch (error) {
    rowError[receipt.id] = errorMessage(error, 'Не удалось изменить привязку')
  } finally {
    busy[receipt.id] = false
  }
}

async function removeReceipt(receipt: Receipt) {
  if (busy[receipt.id]) return
  busy[receipt.id] = true
  rowError[receipt.id] = ''
  try {
    await $fetch(`/api/receipts/${receipt.id}`, { method: 'DELETE' })
    await Promise.all([refresh(), refreshRefuels()])
  } catch (error) {
    rowError[receipt.id] = errorMessage(error, 'Не удалось удалить чек')
  } finally {
    busy[receipt.id] = false
  }
}

const pendingCount = computed(() => data.value?.items.filter(item => item.matchStatus === 'unmatched' || item.matchStatus === 'suggested').length || 0)
</script>

<template>
  <div>
    <header class="page-heading refuels-heading">
      <div>
        <p class="eyebrow">Подтверждение заправок</p>
        <h1 class="page-title">Чеки</h1>
      </div>
      <button class="btn" type="button" @click="openCreate">Добавить чек</button>
    </header>

    <div class="receipts-toolbar">
      <div class="chart-switcher" role="group" aria-label="Фильтр чеков">
        <button
          v-for="option in filters"
          :key="option.value"
          class="chart-switcher__button"
          :class="{ 'chart-switcher__button--active': filter === option.value }"
          type="button"
          @click="filter = option.value"
        >{{ option.label }}</button>
      </div>
      <p v-if="filter === 'pending'" class="muted receipts-toolbar__note">
        {{ pendingCount ? `Ждут решения: ${pendingCount}` : 'Всё разобрано' }}
      </p>
    </div>

    <p v-if="status === 'pending'" class="muted">Загрузка…</p>
    <section v-else-if="!data?.items.length" class="card card--wide refuels-empty">
      <p class="metric-label">Инбокс чеков</p>
      <p class="muted">Чеков нет. Они появятся здесь после импорта из почты, из Telegram или после ручного добавления.</p>
    </section>

    <div v-else class="refuel-list">
      <article v-for="receipt in data.items" :key="receipt.id" class="card receipt-card">
        <div class="receipt-card__main">
          <div class="refuel-card__top">
            <p class="eyebrow">{{ date(receipt.purchasedAt) }}</p>
            <span class="confirm-badge" :class="`confirm-badge--${receipt.matchStatus}`">{{ statusLabels[receipt.matchStatus] }}</span>
          </div>
          <p class="refuel-card__amount">{{ number(receipt.litres) }} <small>л</small></p>
          <dl class="refuel-meta">
            <div><dt>Сумма</dt><dd>{{ money(receipt.totalAmount) }}</dd></div>
            <div><dt>Цена за литр</dt><dd>{{ money(receipt.pricePerLitre) }}</dd></div>
            <div><dt>Вид топлива</dt><dd>{{ receipt.fuelType || '—' }}</dd></div>
            <div><dt>Оплата</dt><dd>{{ receipt.paymentMethod === 'cash' ? 'Наличные' : receipt.paymentMethod === 'card' ? 'Карта' : '—' }}</dd></div>
            <div><dt>Источник</dt><dd>{{ originLabels[receipt.source] || receipt.source }}</dd></div>
            <div><dt>АЗС</dt><dd>{{ receipt.stationName || receipt.station || '—' }}</dd></div>
          </dl>
        </div>

        <div class="receipt-panel receipt-card__side">
          <p class="metric-label">Заправка</p>
          <p v-if="receipt.refuel" class="receipt-link">
            Привязан к заправке {{ shortDate(receipt.refuel.detectedAt) }} · {{ number(receipt.refuel.litresAdded) }} л
          </p>
          <p v-else-if="receipt.suggestedRefuel" class="receipt-link">
            Похоже на заправку {{ shortDate(receipt.suggestedRefuel.detectedAt) }} · {{ number(receipt.suggestedRefuel.litresAdded) }} л
            <small v-if="receipt.matchScore">совпадение {{ Math.round(receipt.matchScore * 100) }}%</small>
          </p>
          <p v-else class="muted receipt-empty">Подходящей заправки не нашлось.</p>

          <label class="field receipt-picker">
            <span>Выбрать заправку вручную</span>
            <select
              :disabled="busy[receipt.id]"
              @change="act(receipt, { action: 'link', refuelEventId: Number(($event.target as HTMLSelectElement).value) })"
            >
              <option value="" selected disabled>Из последних заправок</option>
              <option v-for="refuel in refuelsData?.items || []" :key="refuel.id" :value="refuel.id">
                {{ shortDate(refuel.detectedAt) }} · {{ number(refuel.litresAdded) }} л
              </option>
            </select>
          </label>

          <div class="receipt-actions">
            <button
              v-if="receipt.suggestedRefuel"
              class="btn"
              type="button"
              :disabled="busy[receipt.id]"
              @click="act(receipt, { action: 'link' })"
            >Подтвердить</button>
            <button class="btn btn--secondary" type="button" :disabled="busy[receipt.id]" @click="openEdit(receipt)">Править</button>
            <button
              v-if="receipt.matchStatus !== 'rejected'"
              class="btn btn--secondary"
              type="button"
              :disabled="busy[receipt.id]"
              @click="act(receipt, { action: 'reject' })"
            >Не заправка</button>
            <button
              v-if="!receipt.refuel"
              class="btn btn--secondary"
              type="button"
              :disabled="busy[receipt.id]"
              @click="act(receipt, { action: 'create-refuel' })"
            >Создать заправку</button>
            <a v-if="receipt.storedName" class="btn btn--secondary" :href="`/api/refuel-receipts/${receipt.id}`">Файл</a>
            <button class="refuel-edit receipt-delete" type="button" :disabled="busy[receipt.id]" @click="removeReceipt(receipt)">Удалить</button>
          </div>
          <p v-if="rowError[receipt.id]" class="error">{{ rowError[receipt.id] }}</p>
        </div>
      </article>
    </div>

    <AppModal
      :model-value="creating || Boolean(editing)"
      :title="editing ? 'Правка чека' : 'Новый чек'"
      :eyebrow="editing ? editing.title : 'Наличные или бумажный чек'"
      :close-on-backdrop="!formPending"
      :close-on-escape="!formPending"
      @update:model-value="value => { if (!value && !formPending) closeForm() }"
    >
      <form id="receipt-form" class="refuel-details-form" @submit.prevent="submitForm">
        <label class="field refuel-details-form__wide">
          <span>Дата и время</span>
          <input v-model="form.purchasedAt" required type="datetime-local" :disabled="formPending">
        </label>
        <label class="field">
          <span>АЗС</span>
          <select v-model="form.station" :disabled="formPending">
            <option value="">Не указана</option>
            <option value="rosneft">Роснефть</option>
            <option value="lukoil">Лукойл</option>
            <option value="other">Другая АЗС</option>
          </select>
        </label>
        <label class="field">
          <span>Способ оплаты</span>
          <select v-model="form.paymentMethod" :disabled="formPending">
            <option value="cash">Наличные</option>
            <option value="card">Карта</option>
            <option value="unknown">Не указан</option>
          </select>
        </label>
        <label v-if="form.station === 'other'" class="field refuel-details-form__wide">
          <span>Название АЗС</span>
          <input v-model="form.stationName" required maxlength="100" placeholder="Введите название">
        </label>
        <label class="field">
          <span>Объём, л</span>
          <input v-model="form.litres" type="number" min="0.01" max="200" step="0.01" inputmode="decimal" placeholder="38,42" @change="completeAmounts">
        </label>
        <label class="field">
          <span>Цена за литр, ₽</span>
          <input v-model="form.pricePerLitre" type="number" min="0.01" max="10000" step="0.01" inputmode="decimal" placeholder="65,50" @change="completeAmounts">
        </label>
        <label class="field">
          <span>Сумма, ₽</span>
          <input v-model="form.totalAmount" type="number" min="0.01" max="10000000" step="0.01" inputmode="decimal" placeholder="2500,00" @change="completeAmounts">
        </label>
        <label class="field">
          <span>Вид топлива</span>
          <input v-model="form.fuelType" maxlength="50" list="receipt-fuel-types" placeholder="Например, АИ-95">
          <datalist id="receipt-fuel-types">
            <option value="АИ-92" />
            <option value="АИ-95" />
            <option value="АИ-95 Премиум" />
            <option value="АИ-98" />
            <option value="АИ-100" />
          </datalist>
        </label>
        <p class="muted refuel-details-form__wide receipt-hint">
          Достаточно любых двух из трёх значений — объём, цена и сумма: третье посчитается само.
        </p>
        <div v-if="!editing" class="refuel-details-form__wide receipt-capture">
          <label class="btn btn--secondary receipt-upload">
            {{ attachment ? 'Фото выбрано' : 'Сфотографировать чек' }}
            <input type="file" accept="image/*" capture="environment" :disabled="formPending" @change="pickFile">
          </label>
          <label class="btn btn--secondary receipt-upload">
            Выбрать файл
            <input
              type="file"
              accept=".jpg,.jpeg,.png,.gif,.webp,.avif,.heic,.heif,.pdf,.html,.htm"
              :disabled="formPending"
              @change="pickFile"
            >
          </label>
          <span v-if="attachment" class="muted receipt-capture__name">{{ attachment.name }}</span>
        </div>
        <p v-if="formError" class="error refuel-details-form__wide">{{ formError }}</p>
      </form>
      <template #footer>
        <button class="btn btn--secondary" type="button" :disabled="formPending" @click="closeForm">Отмена</button>
        <button class="btn" type="submit" form="receipt-form" :disabled="formPending">{{ formPending ? 'Сохраняем…' : 'Сохранить' }}</button>
      </template>
    </AppModal>
  </div>
</template>
