<script setup lang="ts">
// A file picker cannot be a `button`, so it is a label wearing the button's
// clothes with the input hidden inside it.
withDefaults(defineProps<{
  label: string
  busyLabel?: string
  accept?: string
  capture?: 'user' | 'environment'
  busy?: boolean
  disabled?: boolean
}>(), {
  busyLabel: '',
  accept: undefined,
  capture: undefined
})

const emit = defineEmits<{ select: [File] }>()

// The input is emptied on every pick, so choosing the same file twice in a row
// still counts as a change.
function onChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) emit('select', file)
}
</script>

<template>
  <label class="btn btn--secondary file-button" :class="{ 'file-button--busy': busy }">
    {{ busy && busyLabel ? busyLabel : label }}
    <input type="file" :accept="accept" :capture="capture" :disabled="disabled || busy" @change="onChange">
  </label>
</template>
