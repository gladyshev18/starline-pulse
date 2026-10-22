<script setup lang="ts" generic="T extends string = string">
type Line = string | false | null | undefined

const props = withDefaults(defineProps<{
  as?: 'section' | 'article' | 'div'
  size?: 'default' | 'half' | 'wide' | 'table'
  variant?: 'default' | 'metric' | 'state' | 'chart'
  skeleton?: boolean
  title?: string
  eyebrow?: string
  subtitle?: Line | Line[]
  badge?: string
  badgeTone?: 'default' | 'warn'
  total?: string
  totalUnit?: string
  switchOptions?: readonly { value: T, label: string }[]
  switchLabel?: string
  action?: { label: string, to: string } | null
}>(), {
  as: 'section',
  size: 'default',
  variant: 'default',
  skeleton: false,
  title: '',
  eyebrow: '',
  subtitle: '',
  badge: '',
  badgeTone: 'default',
  total: '',
  totalUnit: '',
  switchOptions: () => [],
  switchLabel: '',
  action: null
})

// Переключатель вида в шапке: карточка сама держит выбранное значение через
// v-model:switch, страница только отдаёт список вариантов.
const view = defineModel<T>('switch')

const subtitles = computed(() => [props.subtitle].flat().filter((line): line is string => Boolean(line)))
const hasHeader = computed(() => Boolean(
  props.title || props.eyebrow || subtitles.value.length || props.badge || props.total || props.switchOptions.length || props.action
))
</script>

<template>
  <component
    :is="as"
    class="card"
    :class="[
      size !== 'default' && `card--${size}`,
      variant !== 'default' && `${variant === 'chart' ? 'history-chart' : variant}-card`,
      { skeleton }
    ]"
  >
    <div v-if="hasHeader" class="card__top">
      <div v-if="subtitles.length">
        <p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p>
        <p v-else class="metric-label">{{ title }}</p>
        <p v-for="line in subtitles" :key="line" class="muted">{{ line }}</p>
      </div>
      <template v-else>
        <p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p>
        <p v-else class="metric-label">{{ title }}</p>
      </template>
      <span v-if="badge" class="metric-badge" :class="{ 'metric-badge--warn': badgeTone === 'warn' }">{{ badge }}</span>
      <p v-if="total" class="card__total">{{ total }} <small v-if="totalUnit">{{ totalUnit }}</small></p>
      <AppSegmented v-if="switchOptions.length" :model-value="view as T" :options="switchOptions" :label="switchLabel" tabs @update:model-value="view = $event" />
      <AppButton v-if="action" variant="secondary" :to="action.to">{{ action.label }}</AppButton>
    </div>
    <slot />
  </component>
</template>
