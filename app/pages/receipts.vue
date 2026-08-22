<script setup lang="ts">
import { FUEL_TYPES, PAYMENT_METHODS, STATIONS } from '~~/shared/stations'

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

function pickFile(file: File) {
  if (file.size > MAX_FILE_SIZE) {
    formError.value = 'Файл больше 15 МБ'
    attachment.value = null
    return
  }
  formError.value = ''
  attachment.value = file
}

// В поле с `type="number"` Vue кладёт в модель уже число, а не строку, поэтому
// запятую нужно чинить только у того, что действительно пришло текстом.
function amount(value: string | number) {
  const parsed = typeof value === 'number' ? value : Number(value.replace(',', '.'))
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

// The picker lists the same refuels the cards link to, so the labels are built
// once here rather than inside the loop over the receipts.
const refuelOptions = computed(() => (refuelsData.value?.items || []).map(refuel => ({
  value: String(refuel.id),
  label: `${shortDate(refuel.detectedAt)} · ${number(refuel.litresAdded)} л`
})))
</script>

<template>
  <div>
    <header class="page-heading refuels-heading">
      <div>
        <p class="eyebrow">Подтверждение заправок</p>
        <h1 class="page-title">Чеки</h1>
      </div>
      <AppButton @click="openCreate">Добавить чек</AppButton>
    </header>

    <div class="receipts-toolbar">
      <AppSegmented v-model="filter" :options="filters" label="Фильтр чеков" />
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

          <AppField class="receipt-picker" label="Выбрать заправку вручную">
            <AppSelect
              :options="refuelOptions"
              placeholder="Из последних заправок"
              :disabled="busy[receipt.id]"
              @change="value => act(receipt, { action: 'link', refuelEventId: Number(value) })"
            />
          </AppField>

          <div class="receipt-actions">
            <AppButton
              v-if="receipt.suggestedRefuel"
              size="small"
              :disabled="busy[receipt.id]"
              @click="act(receipt, { action: 'link' })"
            >Подтвердить</AppButton>
            <AppButton variant="secondary" size="small" :disabled="busy[receipt.id]" @click="openEdit(receipt)">Править</AppButton>
            <AppButton
              v-if="receipt.matchStatus !== 'rejected'"
              variant="secondary"
              size="small"
              :disabled="busy[receipt.id]"
              @click="act(receipt, { action: 'reject' })"
            >Не заправка</AppButton>
            <AppButton
              v-if="!receipt.refuel"
              variant="secondary"
              size="small"
              :disabled="busy[receipt.id]"
              @click="act(receipt, { action: 'create-refuel' })"
            >Создать заправку</AppButton>
            <AppButton v-if="receipt.storedName" variant="secondary" size="small" :href="`/api/refuel-receipts/${receipt.id}`">Файл</AppButton>
            <AppButton class="receipt-delete" variant="link" tone="danger" :disabled="busy[receipt.id]" @click="removeReceipt(receipt)">Удалить</AppButton>
          </div>
          <AppAlert v-if="rowError[receipt.id]">{{ rowError[receipt.id] }}</AppAlert>
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
      <AppForm id="receipt-form" @submit="submitForm">
        <AppField label="Дата и время" wide>
          <AppInput v-model="form.purchasedAt" required type="datetime-local" :disabled="formPending" />
        </AppField>
        <AppField label="АЗС">
          <AppSelect v-model="form.station" :options="STATIONS" placeholder="Не указана" placeholder-selectable :disabled="formPending" />
        </AppField>
        <AppField label="Способ оплаты">
          <AppSelect v-model="form.paymentMethod" :options="PAYMENT_METHODS" :disabled="formPending" />
        </AppField>
        <AppField v-if="form.station === 'other'" label="Название АЗС" wide>
          <AppInput v-model="form.stationName" required maxlength="100" placeholder="Введите название" />
        </AppField>
        <AppField label="Объём, л">
          <AppInput v-model="form.litres" type="number" min="0.01" max="200" step="0.01" inputmode="decimal" placeholder="38,42" @change="completeAmounts" />
        </AppField>
        <AppField label="Цена за литр, ₽">
          <AppInput v-model="form.pricePerLitre" type="number" min="0.01" max="10000" step="0.01" inputmode="decimal" placeholder="65,50" @change="completeAmounts" />
        </AppField>
        <AppField label="Сумма, ₽">
          <AppInput v-model="form.totalAmount" type="number" min="0.01" max="10000000" step="0.01" inputmode="decimal" placeholder="2500,00" @change="completeAmounts" />
        </AppField>
        <AppField label="Вид топлива">
          <AppInput v-model="form.fuelType" maxlength="50" :suggestions="FUEL_TYPES" placeholder="Например, АИ-95" />
        </AppField>
        <p class="muted form-note form-wide">
          Достаточно любых двух из трёх значений — объём, цена и сумма: третье посчитается само.
        </p>
        <div v-if="!editing" class="form-wide receipt-capture">
          <AppFileButton
            :label="attachment ? 'Фото выбрано' : 'Сфотографировать чек'"
            accept="image/*"
            capture="environment"
            :disabled="formPending"
            @select="pickFile"
          />
          <AppFileButton
            label="Выбрать файл"
            accept=".jpg,.jpeg,.png,.gif,.webp,.avif,.heic,.heif,.pdf,.html,.htm"
            :disabled="formPending"
            @select="pickFile"
          />
          <span v-if="attachment" class="muted receipt-capture__name">{{ attachment.name }}</span>
        </div>
        <AppAlert v-if="formError" wide>{{ formError }}</AppAlert>
      </AppForm>
      <template #footer>
        <AppButton variant="secondary" :disabled="formPending" @click="closeForm">Отмена</AppButton>
        <AppButton type="submit" form="receipt-form" :disabled="formPending">{{ formPending ? 'Сохраняем…' : 'Сохранить' }}</AppButton>
      </template>
    </AppModal>
  </div>
</template>
