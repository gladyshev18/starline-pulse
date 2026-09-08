<script setup lang="ts">
import { BarChart, LineChart } from 'echarts/charts'
import { AriaComponent, GridComponent, TooltipComponent } from 'echarts/components'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import VChart from 'vue-echarts'
import { monthTitle } from '~~/shared/moscow-month'
import type { MonthlyMetric } from '~~/shared/monthly-metrics'

use([BarChart, LineChart, AriaComponent, GridComponent, TooltipComponent, CanvasRenderer])

type MonthlyPoint = { month: string } & Record<string, unknown>

const props = defineProps<{
  items: MonthlyPoint[]
  metric: MonthlyMetric
  // Месяц, открытый на странице: на оси он подписан цветом, чтобы столбец
  // соотносился с карточками над графиком.
  selected?: string
}>()
const emit = defineEmits<{ select: [month: string] }>()
const { theme } = useTheme()

// Год пишется только там, где он меняется, — на январе и в самом начале оси.
// Двадцать четыре подписи «авг 25» не помещаются, а «авг» помещается.
function monthLabel(month: string, index: number) {
  const [year, monthNumber] = month.split('-').map(Number)
  const short = new Intl.DateTimeFormat('ru-RU', { month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year!, monthNumber! - 1, 1)))
    .replace('.', '')
  return index === 0 || monthNumber === 1 ? `${short} ${String(year).slice(2)}` : short
}

function value(item: MonthlyPoint) {
  const raw = item[props.metric.value]
  return raw == null || !Number.isFinite(Number(raw)) ? null : Number(Number(raw).toFixed(4))
}

function format(raw: number | null) {
  if (raw == null) return '—'
  const digits = props.metric.digits
  const formatted = new Intl.NumberFormat('ru-RU', props.metric.money
    ? { style: 'currency', currency: 'RUB', maximumFractionDigits: digits, minimumFractionDigits: digits }
    : { maximumFractionDigits: digits }).format(raw)
  return props.metric.money || !props.metric.unit ? formatted : `${formatted} ${props.metric.unit}`
}

// Двенадцать месяцев назад — то же место в году. Единственное сравнение, в
// котором нет сезонности: январь сравнивать только с январём.
const MONTHS_IN_YEAR = 12

function onSelect(params: { dataIndex?: number }) {
  const month = params.dataIndex == null ? null : props.items[params.dataIndex]?.month
  if (month) emit('select', month)
}

const option = computed(() => {
  const dark = theme.value === 'dark'
  const ink = dark ? '#edf7f2' : '#13231c'
  const muted = dark ? '#91a39a' : '#6d7c74'
  const line = dark ? '#24352d' : '#dfe9e4'
  const accent = dark ? '#38d39c' : '#10a976'
  const fuel = dark ? '#f5bd68' : '#d58718'
  // Деньги отличаются цветом от километров и литров: переключая параметры
  // подряд, по цвету видно, что ось сменила смысл.
  const color = props.metric.money ? fuel : accent
  const bar = props.metric.kind === 'bar'
  const values = props.items.map(value)
  // Тот же ряд, сдвинутый на год: на месте марта две тысячи двадцать шестого
  // стоит март двадцать пятого. Пока года наблюдений нет, линия пуста и не
  // рисуется вовсе.
  const lastYear = props.items.map((_, index) => index >= MONTHS_IN_YEAR ? values[index - MONTHS_IN_YEAR]! : null)
  const hasLastYear = lastYear.some(item => item != null)

  return {
    animationDuration: 450,
    aria: {
      enabled: true,
      description: `График по месяцам: ${props.metric.title.toLowerCase()}${props.metric.unit ? `, ${props.metric.unit}` : ''}.`
    },
    color: [color],
    grid: { top: 30, right: 26, bottom: 42, left: 62, containLabel: false },
    tooltip: {
      trigger: 'axis',
      backgroundColor: dark ? '#17241e' : '#ffffff',
      borderColor: line,
      textStyle: { color: ink, fontFamily: 'ManropeLocal, sans-serif', fontSize: 12 },
      formatter: (params: Array<{ dataIndex: number, marker: string }>) => {
        const first = params[0]
        if (!first) return ''
        const item = props.items[first.dataIndex]
        if (!item) return ''
        const now = values[first.dataIndex] ?? null
        const before = lastYear[first.dataIndex] ?? null
        const head = `${monthTitle(item.month)}<br>${first.marker}<b>${format(now)}</b>`
        if (before == null) return head
        // Проценты считаются тут же, рядом с числами: глазом по двум линиям
        // видно направление, но не то, на сколько.
        const share = before > 0 && now != null ? now / before - 1 : null
        const sign = share == null ? '' : ` (${share > 0 ? '+' : '−'}${Math.round(Math.abs(share) * 100)}%)`
        return `${head}<br><span style="opacity:.7">год назад: ${format(before)}${sign}</span>`
      }
    },
    xAxis: {
      type: 'category',
      boundaryGap: bar,
      data: props.items.map((item, index) => monthLabel(item.month, index)),
      axisLine: { lineStyle: { color: line } },
      axisTick: { show: false },
      axisLabel: {
        color: muted,
        fontFamily: 'ManropeLocal, sans-serif',
        fontSize: 10,
        hideOverlap: true,
        interval: 0,
        formatter: (label: string, index: number) => props.items[index]?.month === props.selected ? `{open|${label}}` : label,
        rich: { open: { color: accent, fontFamily: 'ManropeLocal, sans-serif', fontSize: 10, fontWeight: 700 } }
      }
    },
    yAxis: {
      type: 'value',
      name: props.metric.unit,
      // Ось начинается от нуля только там, где ноль что-то значит.
      scale: !props.metric.zero,
      minInterval: props.metric.digits === 0 ? 1 : 0,
      nameTextStyle: { color: muted, fontSize: 10, padding: [0, 0, 0, -34] },
      axisLabel: {
        color: muted,
        fontSize: 10,
        formatter: (raw: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: props.metric.digits }).format(raw)
      },
      splitLine: { lineStyle: { color: line } }
    },
    series: [{
      name: props.metric.title,
      type: props.metric.kind,
      data: values.map((raw, index) => ({
        value: raw,
        // Открытый месяц светится, остальные приглушены: иначе на двух десятках
        // одинаковых столбцов не найти тот, о котором рассказывают карточки.
        itemStyle: props.selected && props.items[index]?.month !== props.selected ? { opacity: 0.45 } : {}
      })),
      barMaxWidth: 26,
      itemStyle: { borderRadius: bar ? [4, 4, 1, 1] : 0 },
      smooth: 0.24,
      // Разрыв в линии — это месяц без данных, и соединять его края нечем.
      connectNulls: false,
      symbol: 'circle',
      symbolSize: (_raw: unknown, params: { dataIndex: number }) => props.items[params.dataIndex]?.month === props.selected ? 9 : 5,
      lineStyle: { width: 2.5 },
      areaStyle: bar ? undefined : { opacity: 0.08 }
    },
    // Прошлый год идёт пунктиром позади: он здесь для сравнения, а не наравне с
    // основным рядом, и перетягивать взгляд не должен.
    ...(hasLastYear
      ? [{
          name: 'Год назад',
          type: 'line' as const,
          data: lastYear,
          color: muted,
          z: 1,
          smooth: 0.24,
          connectNulls: false,
          symbol: 'none' as const,
          lineStyle: { width: 1.5, type: 'dashed' as const, color: muted, opacity: 0.7 }
        }]
      : [])]
  }
})
</script>

<template>
  <VChart class="history-chart" :option="option" autoresize @click="onSelect" />
</template>
