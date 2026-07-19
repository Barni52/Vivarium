import type { VivariumApi } from './index'

declare global {
  interface Window {
    vivarium: VivariumApi
  }
}

export {}
