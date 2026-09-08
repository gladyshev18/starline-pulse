<script setup lang="ts">
import type { NuxtError } from '#app'

// Nuxt рисует эту страницу вместо всего приложения, поэтому layout сюда не
// приходит: шапки, темы и шрифтов у неё нет, если не позвать их самой.
const props = defineProps<{ error: NuxtError }>()

const status = computed(() => props.error?.statusCode ?? 500)

const title = computed(() => (status.value === 404 ? 'Страница не найдена' : 'Что-то сломалось'))

const explanation = computed(() => (status.value === 404
  ? 'Такого адреса в приложении нет. Возможно, ссылка устарела или в ней опечатка.'
  : 'Запрос не удалось выполнить. Попробуйте обновить страницу или вернуться на обзор.'))
</script>

<template>
  <div class="container">
    <header class="error-header">
      <NuxtLink class="brand" to="/" aria-label="StarLine Pulse — главная">
        <BrandLogo compact />
      </NuxtLink>
      <ThemeToggle />
    </header>
    <main class="error-shell">
      <p class="eyebrow">Ошибка {{ status }}</p>
      <h1 class="page-title">{{ title }}</h1>
      <p class="error-shell__text">{{ explanation }}</p>
      <p v-if="error?.message && status !== 404" class="error-shell__detail">{{ error.message }}</p>
      <AppButton class="error-shell__action" @click="clearError({ redirect: '/' })">
        Вернуться на обзор
      </AppButton>
    </main>
  </div>
</template>
