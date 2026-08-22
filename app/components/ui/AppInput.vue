<script setup lang="ts">
defineOptions({ inheritAttrs: false })

// `suggestions` builds the datalist for the field, so a page never has to keep
// an id in sync between an input and a list somewhere below it.
const props = withDefaults(defineProps<{ suggestions?: readonly string[] }>(), {
  suggestions: () => []
})

const model = defineModel<string | number | null>()
const listId = useId()
const list = computed(() => (props.suggestions.length ? listId : undefined))
</script>

<template>
  <input v-model="model" class="control" :list="list" v-bind="$attrs">
  <datalist v-if="suggestions.length" :id="listId">
    <option v-for="item in suggestions" :key="item" :value="item" />
  </datalist>
</template>
