<script setup lang="ts">
withDefaults(defineProps<{ compact?: boolean, tagline?: boolean }>(), { compact: false, tagline: false })
</script>

<template>
  <span class="brand-logo" :class="{ 'brand-logo--compact': compact }">
    <img class="brand-logo__mark" src="/brand/starline-pulse-mark.svg" width="56" height="56" alt="">
    <span class="brand-logo__copy">
      <span class="brand-logo__name">StarLine <span>Pulse</span></span>
      <span v-if="tagline" class="brand-logo__tagline">Чувствуй свою машину</span>
    </span>
  </span>
</template>
