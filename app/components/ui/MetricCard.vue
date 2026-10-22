<script lang="ts">
export type MetricMetaTone = 'primary' | 'stale' | 'verdict' | 'urgent'
export type MetricMetaLine = string | { text: string, tone?: MetricMetaTone | MetricMetaTone[] }

export interface MetricCardProps {
  title: string
  subtitle?: string
  value: string | number
  unit?: string
  compact?: boolean
  size?: 'default' | 'half' | 'wide'
  variant?: 'default' | 'metric'
  badge?: string
  badgeTone?: 'default' | 'warn'
  note?: string
  meta?: (MetricMetaLine | false | null | undefined)[]
  footer?: boolean
}
</script>

<script setup lang="ts">
const props = withDefaults(defineProps<MetricCardProps>(), {
  subtitle: '',
  unit: '',
  compact: false,
  size: 'default',
  variant: 'default',
  badge: '',
  badgeTone: 'default',
  note: '',
  meta: () => [],
  footer: false
})

const lines = computed(() => props.meta.flatMap((line) => {
  if (!line) return []
  const { text, tone } = typeof line === 'string' ? { text: line, tone: undefined } : line
  const tones = tone === undefined ? [] : Array.isArray(tone) ? tone : [tone]
  return [{ text, classes: tones.map(item => `metric-meta--${item}`) }]
}))
</script>

<template>
  <AppCard :size="size" :variant="variant" :title="title" :subtitle="subtitle" :badge="badge" :badge-tone="badgeTone">
    <p class="metric" :class="{ 'metric--compact': compact }">{{ value }} <small v-if="unit">{{ unit }}</small></p>
    <div v-if="footer" class="metric-card__footer">
      <p v-if="note" class="muted">{{ note }}</p>
      <p v-for="(line, index) in lines" :key="index" class="metric-meta" :class="line.classes">{{ line.text }}</p>
    </div>
    <template v-else>
      <p v-if="note" class="muted">{{ note }}</p>
      <p v-for="(line, index) in lines" :key="index" class="metric-meta" :class="line.classes">{{ line.text }}</p>
    </template>
    <slot />
  </AppCard>
</template>
