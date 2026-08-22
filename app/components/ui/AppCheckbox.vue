<script setup lang="ts">
defineOptions({ inheritAttrs: false })

withDefaults(defineProps<{
  label?: string
  wide?: boolean
}>(), {
  label: ''
})

const model = defineModel<boolean>({ default: false })
</script>

<template>
  <label class="checkbox" :class="{ 'form-wide': wide }">
    <input v-model="model" type="checkbox" v-bind="$attrs">
    <span><slot>{{ label }}</slot></span>
  </label>
</template>
