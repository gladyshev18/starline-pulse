<script setup lang="ts">
// Two layouts cover every form in the app: a two-column grid for the modals and
// a single stack for the short ones. The submit is always intercepted, so no
// page has to remember `.prevent`.
withDefaults(defineProps<{ layout?: 'grid' | 'stack' }>(), { layout: 'grid' })

const emit = defineEmits<{ submit: [] }>()
</script>

<template>
  <form :class="layout === 'stack' ? 'form-stack' : 'form-grid'" @submit.prevent="emit('submit')">
    <slot />
  </form>
</template>
