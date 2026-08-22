<script setup lang="ts">
defineProps<{ wide?: boolean }>()
</script>

<template>
  <p class="error" :class="{ 'form-wide': wide }" role="alert"><slot /></p>
</template>
