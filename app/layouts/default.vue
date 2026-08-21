<script setup lang="ts">
const { user, clear } = useUserSession()
const route = useRoute()
const menuOpen = ref(false)
const header = ref<HTMLElement | null>(null)
const toggle = ref<HTMLButtonElement | null>(null)

async function logout() {
  await clear()
  await navigateTo('/login')
}

// Following a link leaves the panel covering the page it just opened, so the
// route itself closes the menu rather than every link having to remember to.
watch(() => route.fullPath, () => { menuOpen.value = false })

function closeAndReturnFocus() {
  if (!menuOpen.value) return
  menuOpen.value = false
  toggle.value?.focus()
}

function onDocumentPointerDown(event: PointerEvent) {
  if (!menuOpen.value) return
  if (event.target instanceof Node && header.value?.contains(event.target)) return
  menuOpen.value = false
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeAndReturnFocus()
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="container">
    <header ref="header" class="app-header">
      <NuxtLink class="brand" to="/" aria-label="Chery Pulse — главная">
        <BrandLogo compact />
      </NuxtLink>
      <button
        ref="toggle"
        class="icon-button nav-toggle"
        type="button"
        :aria-expanded="menuOpen"
        :aria-label="menuOpen ? 'Закрыть меню' : 'Открыть меню'"
        aria-controls="site-nav"
        @click="menuOpen = !menuOpen"
      >
        <span class="nav-toggle__box" aria-hidden="true">
          <span class="nav-toggle__bar" />
          <span class="nav-toggle__bar" />
          <span class="nav-toggle__bar" />
        </span>
      </button>
      <nav id="site-nav" class="nav" :class="{ 'nav--open': menuOpen }" aria-label="Основная навигация">
        <NuxtLink to="/">Обзор</NuxtLink>
        <NuxtLink to="/history">История</NuxtLink>
        <NuxtLink to="/trips">Поездки</NuxtLink>
        <NuxtLink to="/refuels">Заправки</NuxtLink>
        <NuxtLink to="/receipts">Чеки</NuxtLink>
        <NuxtLink to="/service">ТО</NuxtLink>
        <NuxtLink to="/api-logs">API</NuxtLink>
        <span class="nav__separator" aria-hidden="true" />
        <ThemeToggle />
        <button class="nav__logout" type="button" :title="`Выйти: ${user?.displayName ?? ''}`" @click="logout">Выйти</button>
      </nav>
    </header>
    <main class="page"><slot /></main>
  </div>
</template>
