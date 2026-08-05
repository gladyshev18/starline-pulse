<script setup lang="ts">
const route = useRoute()
const page = computed(() => Math.max(1, Number(route.query.page) || 1))
const { data, status } = await useFetch('/api/trips', { query: { page } })

function number(value: number | null, digits = 1) { return value == null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value) }
function date(value: string | Date) { return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) }
function consumption(distance: number | null, fuel: number | null) { return distance && fuel != null ? fuel / distance * 100 : null }
</script>

<template>
  <div>
    <header class="page-heading">
      <div><p class="eyebrow">История</p><h1 class="page-title">Поездки</h1></div>
    </header>
    <section class="card card--table">
      <div class="card__top"><p class="metric-label">Журнал поездок</p></div>
      <p v-if="status === 'pending'">Загрузка…</p>
      <div v-else-if="!data?.items.length" class="muted">Завершённых поездок пока нет.</div>
      <div v-else class="table-wrap">
        <table>
          <thead><tr><th>Дата</th><th>Расстояние</th><th>Топливо</th><th>Расход</th></tr></thead>
          <tbody><tr v-for="trip in data.items" :key="trip.id"><td>{{ date(trip.startedAt) }}</td><td>{{ number(trip.distance) }} км</td><td>{{ number(trip.fuelUsed) }} л</td><td>{{ number(consumption(trip.distance, trip.fuelUsed)) }} л/100 км</td></tr></tbody>
        </table>
      </div>
      <nav v-if="data && data.pages > 1" class="pagination" aria-label="Страницы поездок">
        <NuxtLink class="btn btn--secondary" :style="{ visibility: page > 1 ? 'visible' : 'hidden' }" :to="{ query: { page: page - 1 } }">Назад</NuxtLink>
        <span class="muted">{{ page }} / {{ data.pages }}</span>
        <NuxtLink class="btn btn--secondary" :style="{ visibility: page < data.pages ? 'visible' : 'hidden' }" :to="{ query: { page: page + 1 } }">Дальше</NuxtLink>
      </nav>
    </section>
  </div>
</template>
