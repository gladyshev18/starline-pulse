<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'

// A square button holding nothing but an icon. `inactive` renders the same box
// without a target — a control that leads nowhere is not a control, so it leaves
// both the tab order and the accessibility tree.
withDefaults(defineProps<{
  label: string
  title?: string
  to?: RouteLocationRaw
  type?: 'button' | 'submit'
  disabled?: boolean
  inactive?: boolean
}>(), {
  title: '',
  to: undefined,
  type: 'button'
})
</script>

<template>
  <span v-if="inactive" class="icon-button icon-button--inactive" aria-hidden="true"><slot /></span>
  <NuxtLink v-else-if="to" class="icon-button" :to="to" :aria-label="label" :title="title || undefined"><slot /></NuxtLink>
  <button v-else class="icon-button" :type="type" :aria-label="label" :title="title || undefined" :disabled="disabled">
    <slot />
  </button>
</template>
