<script setup lang="ts">
defineOptions({ inheritAttrs: false })

withDefaults(defineProps<{
  rows?: number
  maxlength?: number
  counter?: boolean
}>(), {
  rows: 6,
  maxlength: undefined
})

const model = defineModel<string>({ default: '' })
</script>

<template>
  <textarea v-model="model" class="control" :rows="rows" :maxlength="maxlength" v-bind="$attrs" />
  <span v-if="counter && maxlength" class="field__counter">{{ model.length }} / {{ maxlength }}</span>
</template>
