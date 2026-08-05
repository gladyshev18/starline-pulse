<script setup lang="ts">
definePageMeta({ layout: false })
const { loggedIn, fetch: fetchSession } = useUserSession()
if (loggedIn.value) await navigateTo('/')

const form = reactive({ login: '', password: '' })
const pending = ref(false)
const errorMessage = ref('')

async function submit() {
  pending.value = true
  errorMessage.value = ''
  try {
    await $fetch('/api/login', { method: 'POST', body: form })
    await fetchSession()
    await navigateTo('/')
  } catch (error: any) {
    errorMessage.value = error?.data?.statusMessage || 'Не удалось войти'
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <main class="login-shell">
    <header class="login-header">
      <BrandLogo />
      <ThemeToggle />
    </header>
    <section class="login-card">
      <div class="login-card__head">
        <div><p class="eyebrow">Личный кабинет</p><h1>Вход</h1></div>
      </div>
      <form class="login-form" @submit.prevent="submit">
        <div class="field"><label for="login">Логин</label><input id="login" v-model="form.login" autocomplete="username" required></div>
        <div class="field"><label for="password">Пароль</label><input id="password" v-model="form.password" type="password" autocomplete="current-password" required></div>
        <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
        <button class="btn" type="submit" :disabled="pending">{{ pending ? 'Проверяем…' : 'Войти' }}</button>
      </form>
    </section>
  </main>
</template>
