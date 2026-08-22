<script setup lang="ts">
// The label wraps its control instead of pointing at it by id: nothing has to
// invent unique ids, and the whole row stays clickable.
withDefaults(defineProps<{
  label?: string
  hint?: string
  wide?: boolean
}>(), {
  label: '',
  hint: ''
})
</script>

<template>
  <label class="field" :class="{ 'form-wide': wide }">
    <span v-if="label" class="field__label">{{ label }}</span>
    <slot />
    <span v-if="hint" class="field__hint">{{ hint }}</span>
  </label>
</template>
