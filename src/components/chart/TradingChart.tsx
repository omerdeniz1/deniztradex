import { useEffect, useRef, memo } from 'react'
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { useEffectiveTheme } from '@/hooks/useEffectiveTheme'
import { boll, ema, sma } from '@/lib/indicators'
import type { Kline } from '@/types'

export interface ChartIndicators {
  ma: boolean
  ema: boolean
  boll: boolean
  volume: boolean
}

export const NO_INDICATORS: ChartIndicators = {
  ma: false,
  ema: false,
  boll: false,
  volume: false,
}

interface Props {
  klines: Kline[]
  className?: string
  indicators?: ChartIndicators
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

const MA_FAST = 7
const MA_SLOW = 25
const EMA_FAST = 12
const EMA_SLOW = 26
const BOLL_PERIOD = 20
const BOLL_MULT = 2

const VOL_UP = 'rgba(0, 200, 83, 0.45)'
const VOL_DOWN = 'rgba(255, 61, 0, 0.45)'

function toTime(openTime: number): UTCTimestamp {
  return (openTime / 1000) as UTCTimestamp
}

function TradingChartInner({ klines, className, indicators = NO_INDICATORS }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const overlaysRef = useRef<{
    maFast: ISeriesApi<'Line'> | null
    maSlow: ISeriesApi<'Line'> | null
    emaFast: ISeriesApi<'Line'> | null
    emaSlow: ISeriesApi<'Line'> | null
    bollBasis: ISeriesApi<'Line'> | null
    bollUpper: ISeriesApi<'Line'> | null
    bollLower: ISeriesApi<'Line'> | null
    volume: ISeriesApi<'Histogram'> | null
  }>({
    maFast: null,
    maSlow: null,
    emaFast: null,
    emaSlow: null,
    bollBasis: null,
    bollUpper: null,
    bollLower: null,
    volume: null,
  })
  const theme = useEffectiveTheme()

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

    const lineOpts = {
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      lineWidth: 1 as const,
    }
    const ov = overlaysRef.current
    ov.maFast = chart.addSeries(LineSeries, { ...lineOpts, color: '#00e5ff' })
    ov.maSlow = chart.addSeries(LineSeries, { ...lineOpts, color: '#8b95a1' })
    ov.emaFast = chart.addSeries(LineSeries, { ...lineOpts, color: COLOR_GREEN })
    ov.emaSlow = chart.addSeries(LineSeries, { ...lineOpts, color: COLOR_RED })
    ov.bollBasis = chart.addSeries(LineSeries, {
      ...lineOpts,
      color: '#f1f5f9',
      lineStyle: LineStyle.Dashed,
    })
    ov.bollUpper = chart.addSeries(LineSeries, { ...lineOpts, color: '#5b6b7c' })
    ov.bollLower = chart.addSeries(LineSeries, { ...lineOpts, color: '#5b6b7c' })
    ov.volume = chart.addSeries(HistogramSeries, {
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      lastValueVisible: false,
    })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })

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
      overlaysRef.current = {
        maFast: null,
        maSlow: null,
        emaFast: null,
        emaSlow: null,
        bollBasis: null,
        bollUpper: null,
        bollLower: null,
        volume: null,
      }
    }
  }, [theme])

  useEffect(() => {
    const series = seriesRef.current
    if (!series || klines.length === 0) return

    const data = klines.map((k) => ({
      time: toTime(k.openTime),
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    }))

    series.setData(data)

    chartRef.current?.timeScale().scrollToRealTime()

    // İndikatör katmanları — kapalı olanlar gizlenir (seri silinmez).
    const ov = overlaysRef.current
    const closes = klines.map((k) => k.close)
    const at = (i: number) => toTime(klines[i].openTime)

    const setLine = (
      s: ISeriesApi<'Line'> | null,
      on: boolean,
      values: (number | null)[],
    ) => {
      if (!s) return
      if (on) {
        s.setData(
          values.flatMap((v, i) => (v === null ? [] : [{ time: at(i), value: v }])),
        )
      }
      s.applyOptions({ visible: on })
    }

    setLine(ov.maFast, indicators.ma, sma(closes, MA_FAST))
    setLine(ov.maSlow, indicators.ma, sma(closes, MA_SLOW))
    setLine(ov.emaFast, indicators.ema, ema(closes, EMA_FAST))
    setLine(ov.emaSlow, indicators.ema, ema(closes, EMA_SLOW))
    const bands = boll(closes, BOLL_PERIOD, BOLL_MULT)
    setLine(ov.bollBasis, indicators.boll, bands.basis)
    setLine(ov.bollUpper, indicators.boll, bands.upper)
    setLine(ov.bollLower, indicators.boll, bands.lower)

    if (ov.volume) {
      if (indicators.volume) {
        ov.volume.setData(
          klines.map((k) => ({
            time: toTime(k.openTime),
            value: k.volume,
            color: k.close >= k.open ? VOL_UP : VOL_DOWN,
          })),
        )
      }
      ov.volume.applyOptions({ visible: indicators.volume })
    }
  }, [klines, indicators])

  useEffect(() => {
    if (klines.length === 0) return
    const series = seriesRef.current
    if (!series) return

    const last = klines[klines.length - 1]
    series.update({
      time: toTime(last.openTime),
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
    })
  }, [klines])

  return <div ref={containerRef} className={className} />
}

export const TradingChart = memo(TradingChartInner)
