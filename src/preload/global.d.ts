import type { QaingBridge } from '../core/contracts'

declare global {
  interface Window {
    readonly qaing: QaingBridge
  }
}
export {}
