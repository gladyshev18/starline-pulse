<script setup lang="ts">
import { LineChart } from 'echarts/charts'
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import VChart from 'vue-echarts'
import { STATIONS } from '~~/shared/stations'

use([LineChart, AriaComponent, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

type PricePoint = {
  at: string | Date
  price: number
  litres: number | null
  station: string | null
  stationName: string | null
}

// Один график — один вид топлива, как и вся остальная карточка: на общей шкале
// АИ-92 сидит рублей на пять ниже АИ-95, и обе линии превращаются в прямые.
const props = defineProps<{ fuelType: string, points: PricePoint[] }>()
const { theme } = useTheme()

function stationLabel(station: string | null, stationName: string | null) {
  return stationName || STATIONS.find(item => item.value === station)?.label || 'Другая АЗС'
}

// Линия рисуется по одной сети: цену у Роснефти и у Лукойла соединять нечем,
// между соседними точками разных сетей не движение цены, а разница мест.
const groups = computed(() => {
  const map = new Map<string, { station: string | null, name: string, points: PricePoint[] }>()
  for (const point of props.points) {
    const key = point.station ?? ''
    const group = map.get(key) ?? {
      station: point.station,
      name: stationLabel(point.station, point.stationName),
      points: []
    }
    group.points.push(point)
    map.set(key, group)
  }
  return [...map.values()]
})

// Название АЗС пишет человек в форме чека, а подсказка собирается разметкой:
// в неё оно попадает только экранированным.
function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] || char))
}

const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' })
const volume = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 })
const shortDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' })
const longDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' })

const option = computed(() => {
  const dark = theme.value === 'dark'
  const ink = dark ? '#edf7f2' : '#13231c'
  const muted = dark ? '#91a39a' : '#6d7c74'
  const line = dark ? '#24352d' : '#dfe9e4'
  // Цвета взяты у марок на карточках заправок, но приглушены до читаемых на
  // светлом фоне: фирменный жёлтый Роснефти линией на белом не виден вовсе.
  const stationColors: Record<string, string> = dark
    ? { rosneft: '#f5bd68', lukoil: '#f0736f', other: '#38d39c' }
    : { rosneft: '#d58718', lukoil: '#c8202a', other: '#10a976' }

  return {
    animationDuration: 450,
    aria: {
      enabled: true,
      description: `График цены литра ${props.fuelType} по чекам: отдельная линия на каждую сеть заправок.`
    },
    grid: { top: 52, right: 26, bottom: 34, left: 58, containLabel: false },
    legend: {
      top: 0,
      left: 0,
      itemWidth: 18,
      itemHeight: 8,
      itemGap: 16,
      textStyle: { color: muted, fontFamily: 'ManropeLocal, sans-serif', fontSize: 11 }
    },
    tooltip: {
      trigger: 'item',
      backgroundColor: dark ? '#17241e' : '#ffffff',
      borderColor: line,
      textStyle: { color: ink, fontFamily: 'ManropeLocal, sans-serif', fontSize: 12 },
      formatter: (params: { seriesName: string, marker: string, data: [number, number, number | null] }) => {
        const [at, price, litres] = params.data
        const litresText = litres != null ? ` · ${volume.format(litres)} л` : ''
        return `${longDate.format(new Date(at))}<br>${params.marker}<b>${escapeHtml(params.seriesName)}</b>`
          + `<br>${money.format(price)}/л${litresText}`
      }
    },
    xAxis: {
      type: 'time',
      // Крайние чеки без отступа упираются в рамку графика и режутся пополам.
      min: (value: { min: number }) => value.min - 43_200_000,
      max: (value: { max: number }) => value.max + 43_200_000,
      axisLine: { lineStyle: { color: line } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: {
        color: muted,
        fontFamily: 'ManropeLocal, sans-serif',
        fontSize: 10,
        hideOverlap: true,
        formatter: (value: number) => shortDate.format(new Date(value))
      }
    },
    yAxis: {
      type: 'value',
      name: '₽/л',
      // Ноль на этой оси не нужен: разница между сетями — рубли при цене под
      // семьдесят, от нуля она превратилась бы в одну плоскую линию.
      scale: true,
      nameTextStyle: { color: muted, fontSize: 10, padding: [0, 0, 0, -32] },
      axisLabel: {
        color: muted,
        fontSize: 10,
        formatter: (value: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value)
      },
      splitLine: { lineStyle: { color: line } }
    },
    series: groups.value.map(group => ({
      name: group.name,
      type: 'line',
      color: stationColors[group.station ?? 'other'] || stationColors.other,
      data: group.points
        .map(point => [new Date(point.at).getTime(), point.price, point.litres] as [number, number, number | null])
        .sort((left, right) => left[0] - right[0]),
      symbol: 'circle',
      // Сеть с одним чеком рисуется только точкой, и мелкой её легко не заметить.
      symbolSize: group.points.length > 1 ? 8 : 11,
      lineStyle: { width: 2.5 },
      itemStyle: { borderWidth: 2, borderColor: dark ? '#17241e' : '#ffffff' }
    }))
  }
})
</script>

<template>
  <VChart class="price-chart" :option="option" autoresize />
</template>
