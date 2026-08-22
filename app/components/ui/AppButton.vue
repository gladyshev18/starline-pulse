<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'

// One button for the whole app: the tag follows the destination — a route link,
// a plain link or a real button — while the look stays the same everywhere.
const props = withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'link'
  size?: 'regular' | 'small'
  tone?: 'default' | 'danger'
  type?: 'button' | 'submit' | 'reset'
  to?: RouteLocationRaw
  href?: string
  block?: boolean
  disabled?: boolean
}>(), {
  variant: 'primary',
  size: 'regular',
  tone: 'default',
  type: 'button',
  to: undefined,
  href: undefined
})

const classes = computed(() => {
  if (props.variant === 'link') return ['btn-link', { 'btn-link--danger': props.tone === 'danger' }]
  return ['btn', {
    'btn--secondary': props.variant === 'secondary',
    'btn--small': props.size === 'small',
    'btn--block': props.block
  }]
})
</script>

<template>
  <NuxtLink v-if="to" :class="classes" :to="to"><slot /></NuxtLink>
  <a v-else-if="href" :class="classes" :href="href"><slot /></a>
  <button v-else :class="classes" :type="type" :disabled="disabled"><slot /></button>
</template>
