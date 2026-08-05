<script setup lang="ts">
import { BarChart, LineChart } from 'echarts/charts'
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import VChart from 'vue-echarts'

use([BarChart, LineChart, AriaComponent, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

const props = defineProps<{
  items: Array<{ day: string, distance: number, fuelUsed: number }>
}>()
const { theme } = useTheme()

const option = computed(() => {
  const dark = theme.value === 'dark'
  const ink = dark ? '#edf7f2' : '#13231c'
  const muted = dark ? '#91a39a' : '#6d7c74'
  const line = dark ? '#24352d' : '#dfe9e4'
  const accent = dark ? '#38d39c' : '#10a976'
  const fuel = dark ? '#f5bd68' : '#d58718'

  return {
    animationDuration: 450,
    aria: {
      enabled: true,
      description: 'График дневного пробега в километрах и расхода топлива в литрах за выбранный месяц.'
    },
    color: [accent, fuel],
    grid: { top: 54, right: 54, bottom: 42, left: 54, containLabel: false },
    legend: {
      top: 0,
      right: 0,
      itemWidth: 18,
      itemHeight: 8,
      textStyle: { color: muted, fontFamily: 'ManropeLocal, sans-serif', fontSize: 11 }
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: dark ? '#17241e' : '#ffffff',
      borderColor: line,
      textStyle: { color: ink, fontFamily: 'ManropeLocal, sans-serif', fontSize: 12 },
      valueFormatter: (value: unknown) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(Number(value))
    },
    xAxis: {
      type: 'category',
      boundaryGap: true,
      data: props.items.map(item => String(Number(item.day.slice(-2)))),
      axisLine: { lineStyle: { color: line } },
      axisTick: { show: false },
      axisLabel: { color: muted, fontFamily: 'ManropeLocal, sans-serif', fontSize: 10, interval: 2 }
    },
    yAxis: [
      {
        type: 'value',
        name: 'км',
        minInterval: 1,
        nameTextStyle: { color: muted, fontSize: 10, padding: [0, 0, 0, -25] },
        axisLabel: { color: muted, fontSize: 10 },
        splitLine: { lineStyle: { color: line } }
      },
      {
        type: 'value',
        name: 'л',
        minInterval: 1,
        nameTextStyle: { color: muted, fontSize: 10, padding: [0, -25, 0, 0] },
        axisLabel: { color: muted, fontSize: 10 },
        splitLine: { show: false }
      }
    ],
    series: [
      {
        name: 'Пробег, км',
        type: 'bar',
        data: props.items.map(item => Number(item.distance.toFixed(2))),
        barMaxWidth: 18,
        itemStyle: { borderRadius: [4, 4, 1, 1] }
      },
      {
        name: 'Топливо, л',
        type: 'line',
        yAxisIndex: 1,
        data: props.items.map(item => Number(item.fuelUsed.toFixed(2))),
        smooth: 0.28,
        showSymbol: false,
        lineStyle: { width: 2.5 },
        areaStyle: { opacity: 0.08 }
      }
    ]
  }
})
</script>

<template>
  <VChart class="history-chart" :option="option" autoresize />
</template>
