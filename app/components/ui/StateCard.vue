<script setup lang="ts">
withDefaults(defineProps<{
  eyebrow: string
  title: string
  note?: string
  status?: 'unknown' | 'on' | 'offline'
}>(), {
  note: '',
  status: 'unknown'
})
</script>

<template>
  <AppCard variant="state" :eyebrow="eyebrow">
    <div class="state-card__body">
      <div>
        <h2><span class="status-dot" :class="{ 'status-dot--on': status === 'on', 'status-dot--offline': status === 'offline' }" />{{ title }}</h2>
        <p v-if="note" class="muted">{{ note }}</p>
      </div>
    </div>
  </AppCard>
</template>
