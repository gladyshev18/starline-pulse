<script setup lang="ts">
import { LineChart } from 'echarts/charts'
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import VChart from 'vue-echarts'
import { monthTitle } from '~~/shared/moscow-month'
import type { YearPace } from '~~/shared/yearly'

use([LineChart, AriaComponent, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

const props = defineProps<{ pace: YearPace }>()
const { theme } = useTheme()

const distance = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })
const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 })
// Промах бывает и в полпроцента: округление до целых превратило бы его в ноль
// и сделало бы вид, что прогноз идеален.
const share = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 })

// Год на оси помещается целиком, поэтому месяц подписан тремя буквами, а год
// назван один раз — в самом начале.
function monthLabel(month: string, index: number) {
  const [year, monthNumber] = month.split('-').map(Number)
  const short = new Intl.DateTimeFormat('ru-RU', { month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year!, monthNumber! - 1, 1)))
    .replace('.', '')
  return index === 0 ? `${short} ${String(year).slice(2)}` : short
}

function kilometres(value: number | null | undefined) {
  return value == null ? null : `${distance.format(value)} км`
}

const option = computed(() => {
  const dark = theme.value === 'dark'
  const ink = dark ? '#edf7f2' : '#13231c'
  const muted = dark ? '#91a39a' : '#6d7c74'
  const line = dark ? '#24352d' : '#dfe9e4'
  const accent = dark ? '#38d39c' : '#10a976'
  const plan = dark ? '#f5bd68' : '#d58718'
  const points = props.pace.points

  return {
    animationDuration: 450,
    aria: {
      enabled: true,
      description: 'Две линии от начала года к декабрю: накопленный пробег и прогноз, посчитанный по данным до каждого месяца. Расстояние между ними — на сколько прогноз промахнулся.'
    },
    grid: { top: 52, right: 26, bottom: 34, left: 62, containLabel: false },
    legend: {
      // Порядок в легенде свой: прогноз рисуется первым, чтобы лечь под факт,
      // а читается первым факт — он главный.
      data: ['Проехано', 'Прогноз'],
      top: 0,
      left: 0,
      itemWidth: 18,
      itemHeight: 8,
      itemGap: 16,
      textStyle: { color: muted, fontFamily: 'ManropeLocal, sans-serif', fontSize: 11 }
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: dark ? '#17241e' : '#ffffff',
      borderColor: line,
      textStyle: { color: ink, fontFamily: 'ManropeLocal, sans-serif', fontSize: 12 },
      formatter: (params: Array<{ dataIndex: number }>) => {
        const point = points[params[0]?.dataIndex ?? -1]
        if (!point) return ''
        const rows: string[] = []
        // Рубли идут рядом с километрами, а не отдельной осью: на одной шкале
        // с пробегом сумма в рублях была бы в двадцать раз выше и сплющила
        // бы всё остальное в линию у нуля.
        const withMoney = (label: string, km: number | null, spent: number | null) => {
          const value = kilometres(km)
          if (!value) return
          rows.push(`${label}: <b>${value}</b>${spent == null ? '' : ` · ${money.format(spent)}`}`)
        }
        withMoney('Проехано', point.distance, point.spend)
        withMoney(point.distance == null ? 'Прогноз' : 'Прогноз обещал', point.projectedDistance, point.projectedSpend)
        // Ради этой строки график и нарисован двумя линиями: промах читается
        // числом, а не на глаз по расстоянию между ними. Знак — со стороны
        // прогноза: плюс значит, что он обещал больше, чем вышло.
        if (point.distance && point.projectedDistance != null) {
          const gap = point.projectedDistance - point.distance
          const sign = gap >= 0 ? '+' : '−'
          const missed = Math.abs(gap) / point.distance * 100
          rows.push(`<span style="opacity:.7">промах: ${sign}${kilometres(Math.abs(gap))} · ${sign}${share.format(missed)}%</span>`)
        }
        return `${monthTitle(point.month)}<br>${rows.join('<br>')}`
      }
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: points.map((point, index) => monthLabel(point.month, index)),
      axisLine: { lineStyle: { color: line } },
      axisTick: { show: false },
      axisLabel: {
        color: muted,
        fontFamily: 'ManropeLocal, sans-serif',
        fontSize: 10,
        hideOverlap: true,
        interval: 0,
        // Месяц, который идёт сейчас, подписан цветом: на нём кончается факт и
        // начинается арифметика.
        formatter: (label: string, index: number) => points[index]?.month === props.pace.currentMonth ? `{now|${label}}` : label,
        rich: { now: { color: accent, fontFamily: 'ManropeLocal, sans-serif', fontSize: 10, fontWeight: 700 } }
      }
    },
    yAxis: {
      type: 'value',
      name: 'км',
      nameTextStyle: { color: muted, fontSize: 10, padding: [0, 0, 0, -34] },
      axisLabel: { color: muted, fontSize: 10, formatter: (value: number) => distance.format(value) },
      splitLine: { lineStyle: { color: line } }
    },
    series: [
      {
        // Прогноз идёт через весь год и лежит под фактом: сравнивают с ним, а
        // не наоборот, поэтому он тоньше и не перекрывает живую линию.
        name: 'Прогноз',
        type: 'line',
        color: plan,
        data: points.map(point => point.projectedDistance),
        connectNulls: false,
        symbol: 'circle',
        symbolSize: 4,
        lineStyle: { width: 2, type: 'dashed' },
        z: 2
      },
      {
        name: 'Проехано',
        type: 'line',
        color: accent,
        data: points.map(point => point.distance),
        connectNulls: false,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { width: 2.5 },
        areaStyle: { opacity: 0.08 },
        z: 3
      }
    ]
  }
})
</script>

<template>
  <VChart class="history-chart" :option="option" autoresize />
</template>
