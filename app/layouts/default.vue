<script setup lang="ts">
const { user, clear } = useUserSession()

async function logout() {
  await clear()
  await navigateTo('/login')
}
</script>

<template>
  <div class="container">
    <header class="app-header">
      <NuxtLink class="brand" to="/" aria-label="Chery Pulse — главная">
        <BrandLogo compact />
      </NuxtLink>
      <nav class="nav" aria-label="Основная навигация">
        <NuxtLink to="/">Обзор</NuxtLink>
        <NuxtLink to="/trips">Поездки</NuxtLink>
        <span class="nav__separator" aria-hidden="true" />
        <ThemeToggle />
        <button class="nav__logout" type="button" :title="`Выйти: ${user?.displayName ?? ''}`" @click="logout">Выйти</button>
      </nav>
    </header>
    <main class="page"><slot /></main>
  </div>
</template>
