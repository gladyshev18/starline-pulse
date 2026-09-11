<script setup lang="ts">
import { LineChart } from 'echarts/charts'
import { AriaComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent } from 'echarts/components'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import VChart from 'vue-echarts'
import type { AmbientDay, TyreWatch } from '~~/shared/tyres'
import { SWITCH_CELSIUS } from '~~/shared/tyres'

use([LineChart, AriaComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent, CanvasRenderer])

const props = defineProps<{ items: AmbientDay[], watch: Pick<TyreWatch, 'season'> }>()
const { theme } = useTheme()

const dayLabel = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'Europe/Moscow' })

const option = computed(() => {
  const dark = theme.value === 'dark'
  const ink = dark ? '#edf7f2' : '#13231c'
  const muted = dark ? '#91a39a' : '#6d7c74'
  const line = dark ? '#24352d' : '#dfe9e4'
  const mean = dark ? '#38d39c' : '#10a976'
  const night = dark ? '#7fb4ff' : '#3d7fd6'
  const threshold = dark ? '#ff9a8b' : '#cf4f3c'

  // Порог рисуется линией, а зона за ним — заливкой: график читают, чтобы
  // ответить «мы уже там или ещё нет», и ответ должен быть виден без оси.
  const danger = props.watch.season === 'winter'
    ? [[{ yAxis: -100 }, { yAxis: SWITCH_CELSIUS }]]
    : [[{ yAxis: SWITCH_CELSIUS }, { yAxis: 100 }]]

  return {
    animationDuration: 450,
    aria: {
      enabled: true,
      description: `График среднесуточной температуры воздуха по датчику двигателя за последние ${props.items.length} суток, с ночными минимумами и порогом смены шин ${SWITCH_CELSIUS} градусов.`
    },
    color: [mean, night],
    grid: { top: 34, right: 20, bottom: 36, left: 48, containLabel: false },
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
      valueFormatter: (value: unknown) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(Number(value))} °C`
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: props.items.map(item => dayLabel.format(Date.parse(`${item.day}T12:00:00+03:00`))),
      axisLine: { lineStyle: { color: line } },
      axisTick: { show: false },
      axisLabel: { color: muted, fontFamily: 'ManropeLocal, sans-serif', fontSize: 10, hideOverlap: true }
    },
    yAxis: {
      type: 'value',
      name: '°C',
      scale: true,
      // Ось всегда показывает порог с запасом, даже когда погода до него не
      // доходила: без этого черта прижимается к краю и читается как ось.
      min: (value: { min: number }) => Math.floor(Math.min(value.min, SWITCH_CELSIUS - 2)),
      max: (value: { max: number }) => Math.ceil(Math.max(value.max, SWITCH_CELSIUS + 2)),
      nameTextStyle: { color: muted, fontSize: 10, padding: [0, 0, 0, -30] },
      axisLabel: { color: muted, fontSize: 10 },
      splitLine: { lineStyle: { color: line } }
    },
    series: [
      {
        name: 'Среднесуточная',
        type: 'line',
        data: props.items.map(item => Number(item.mean.toFixed(1))),
        smooth: 0.2,
        showSymbol: false,
        lineStyle: { width: 3 },
        markArea: {
          silent: true,
          itemStyle: { color: threshold, opacity: 0.07 },
          data: danger
        },
        markLine: {
          silent: true,
          symbol: 'none',
          label: {
            // Слева внутри графика: у правого края подпись обрезается рамкой
            // на узком экране, а линия без подписи читается как ещё одна ось.
            position: 'insideStartTop',
            color: muted,
            fontSize: 10,
            formatter: `${SWITCH_CELSIUS > 0 ? '+' : ''}${SWITCH_CELSIUS} °C — порог смены`
          },
          lineStyle: { color: threshold, type: 'dashed', width: 1.5 },
          data: [{ yAxis: SWITCH_CELSIUS }]
        }
      },
      {
        name: 'Ночной минимум',
        type: 'line',
        data: props.items.map(item => Number(item.night.toFixed(1))),
        smooth: 0.2,
        showSymbol: false,
        lineStyle: { width: 1.5, opacity: 0.7, type: 'dotted' }
      }
    ]
  }
})
</script>

<template>
  <VChart class="history-chart" :option="option" autoresize />
</template>
