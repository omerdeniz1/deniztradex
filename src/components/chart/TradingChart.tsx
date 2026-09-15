import { useEffect, useRef, memo } from 'react'
import {
  createChart,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { useSettingsStore } from '@/store/settingsStore'
import type { Kline } from '@/types'

interface Props {
  klines: Kline[]
  className?: string
}

const PALETTE = {
  dark: {
    bg: '#151a23',
    border: '#2a2e35',
    text: '#8b95a1',
  },
  light: {
    bg: '#f1f3f5',
    border: '#d7dce2',
    text: '#5b6572',
  },
} as const

const COLOR_GREEN = '#00c853'
const COLOR_RED = '#ff3d00'

function TradingChartInner({ klines, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const theme = useSettingsStore((s) => s.theme)

  useEffect(() => {
    if (!containerRef.current) return

    const palette = PALETTE[theme]

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: palette.bg },
        textColor: palette.text,
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        fontSize: 12,
      },
      grid: {
        vertLines: { color: palette.border },
        horzLines: { color: palette.border },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      timeScale: {
        borderColor: palette.border,
        timeVisible: true,
        secondsVisible: true,
      },
      rightPriceScale: {
        borderColor: palette.border,
      },
    })

    chartRef.current = chart

    const series = chart.addSeries(CandlestickSeries, {
      upColor: COLOR_GREEN,
      downColor: COLOR_RED,
      borderUpColor: COLOR_GREEN,
      borderDownColor: COLOR_RED,
      wickUpColor: COLOR_GREEN,
      wickDownColor: COLOR_RED,
    })
    seriesRef.current = series

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        })
      }
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [theme])

  useEffect(() => {
    const series = seriesRef.current
    if (!series || klines.length === 0) return

    const data = klines.map((k) => ({
      time: (k.openTime / 1000) as UTCTimestamp,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    }))

    series.setData(data)

    chartRef.current?.timeScale().scrollToRealTime()
  }, [klines])

  useEffect(() => {
    if (klines.length === 0) return
    const series = seriesRef.current
    if (!series) return

    const last = klines[klines.length - 1]
    series.update({
      time: (last.openTime / 1000) as UTCTimestamp,
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
    })
  }, [klines])

  return <div ref={containerRef} className={className} />
}

export const TradingChart = memo(TradingChartInner)