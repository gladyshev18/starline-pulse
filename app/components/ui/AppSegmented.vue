<script setup lang="ts" generic="T extends string">
// A row of buttons where exactly one is on. `tabs` is for switches that change
// what the panel below shows; without it the row is a plain filter group.
defineProps<{
  options: readonly { value: T, label: string }[]
  label: string
  tabs?: boolean
}>()

const model = defineModel<T>({ required: true })
</script>

<template>
  <div class="segmented" :role="tabs ? 'tablist' : 'group'" :aria-label="label">
    <button
      v-for="option in options"
      :key="option.value"
      class="segmented__button"
      :class="{ 'segmented__button--active': model === option.value }"
      type="button"
      :role="tabs ? 'tab' : undefined"
      :aria-selected="tabs ? model === option.value : undefined"
      @click="model = option.value"
    >{{ option.label }}</button>
  </div>
</template>
