export type TradingMode = 'spot' | 'futures'
export type OrderSide = 'long' | 'short'
export type OrderType = 'market' | 'limit' | 'stop-market' | 'stop-limit' | 'trailing' | 'oco'
export type TIF = 'GTC' | 'IOC' | 'FOK'
export type TriggerType = 'last' | 'mark'
/** Vadeli marjin modu: pozisyon başına kilitli teminat (İzole) veya hesap bakiyesiyle ortak (Çapraz). */
export type MarginMode = 'isolated' | 'cross'

export interface User {
  readonly id: string
  readonly username: string
  readonly email: string
  readonly createdAt: number
  /** Profil fotoğrafı (Supabase Storage herkese-açık URL'i). Yoksa null. */
  readonly avatarUrl?: string | null
  /** Forumda isim altında görünen özel etiket (örn. "Balina", "Analist"). */
  readonly userTag?: string | null
}

export interface Kline {
  readonly openTime: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly closeTime: number
}

export interface Ticker {
  readonly symbol: string
  readonly price: number
  readonly change24h: number
  readonly changePercent24h: number
  readonly volume24h: number
}

export interface Position {
  readonly id: string
  readonly symbol: string
  readonly side: OrderSide
  readonly entryPrice: number
  readonly quantity: number
  readonly leverage: number
  readonly mode: TradingMode
  readonly openedAt: number
  readonly tpPrice?: number | null
  readonly slPrice?: number | null
  readonly triggerType?: TriggerType
  readonly reduceOnly?: boolean
  /**
   * Margin-call bayrağı: kritik teminat uyarısı üretildiği anın damgası.
   * Pozisyon kârla toparlanırsa watchdog tarafından temizlenir.
   */
  readonly marginCalledAt?: number | null
  /** Yoksa İzole varsayılır (mevcut motor davranışı). */
  readonly marginMode?: MarginMode
}

export interface PositionPnl extends Position {
  readonly currentPrice: number
  readonly pnl: number
  readonly roe: number
  readonly liquidationPrice: number
  readonly isLiquidated: boolean
}

export type Interval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | '1w'