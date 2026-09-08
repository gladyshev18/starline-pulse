<script setup lang="ts">
defineOptions({ inheritAttrs: false })

export interface SelectOption {
  value: string
  label: string
}

// A placeholder is an option that cannot be chosen back unless the page says it
// can: for a required field it stands for "nothing picked yet", for an optional
// one it is a real answer.
withDefaults(defineProps<{
  options: readonly SelectOption[]
  placeholder?: string
  placeholderSelectable?: boolean
}>(), {
  placeholder: ''
})

// Declared rather than left to fall through, so the page gets the chosen value
// instead of digging it out of the event target.
const emit = defineEmits<{ change: [value: string] }>()

const model = defineModel<string>()

function onChange(event: Event) {
  emit('change', (event.target as HTMLSelectElement).value)
}
</script>

<template>
  <!-- Обёртка нужна только ради стрелки: системную мы убираем, а свою рисуем
       псевдоэлементом, чтобы её цвет шёл из переменной темы. -->
  <span class="select">
    <select v-model="model" class="control" v-bind="$attrs" @change="onChange">
      <option v-if="placeholder" value="" :disabled="!placeholderSelectable">{{ placeholder }}</option>
      <option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option>
    </select>
  </span>
</template>
