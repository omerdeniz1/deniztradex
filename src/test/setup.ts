import '@testing-library/jest-dom/vitest'

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
})

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver

export class MockWebSocket {
  static instances: MockWebSocket[] = []
  url: string
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: unknown) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }
  send() {}
  close() {
    this.readyState = 3
  }
  // test helpers
  static openAll() {
    for (const ws of MockWebSocket.instances) {
      ws.readyState = 1
      ws.onopen?.()
    }
  }
  static emit(instanceOrLast: MockWebSocket | undefined, data: unknown) {
    const ws = instanceOrLast ?? MockWebSocket.instances.at(-1)
    ws?.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }
  static reset() {
    MockWebSocket.instances = []
  }
}
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket