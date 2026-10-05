import { existsSync } from 'node:fs'
import type { LaunchOptions } from '@playwright/test'

/**
 * How to start Chromium so that it composites with the graphics card where there is one (docs/12 D-161). On WSL the card is
 * reached through Mesa's d3d12 driver; elsewhere headless Chromium's own choice stands (software, when there is no card).
 */
const WSL_GPU = existsSync('/dev/dxg') && existsSync('/usr/lib/wsl/lib/libd3d12.so')

export const GPU_LAUNCH: LaunchOptions = WSL_GPU
  ? {
      args: [
        '--use-angle=gl',
        '--use-gl=angle',
        '--ignore-gpu-blocklist',
        '--enable-gpu-rasterization',
      ],
      env: {
        ...process.env,
        GALLIUM_DRIVER: 'd3d12',
        LD_LIBRARY_PATH: '/usr/lib/wsl/lib',
      } as Record<string, string>,
    }
  : {}
