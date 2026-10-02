import { CSPProvider } from '@base-ui/react/csp-provider'
import type { Preview } from '@storybook/react-vite'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { MotionConfig } from 'motion/react'
import { useEffect, useMemo } from 'react'
import { Wallpaper } from '../src/components/layout/wallpaper.tsx'
import { Toasts } from '../src/components/ui/toasts.tsx'
import { TooltipProvider } from '../src/components/ui/tooltip.tsx'
import '../src/lib/zod-config.ts'
import { ACCENT_KEYS, GLASS_KEYS } from '../src/design/tokens.ts'
import { installMockApi, type MockApi, restoreFetch } from './mock-api.ts'
import '../src/styles/app.css'

type StoryContext = {
  globals: { theme?: string; accent?: string; glass?: string }
  parameters: { api?: MockApi; route?: string; surface?: 'plain' | 'wallpaper' | 'none' }
}

/** Puts the toolbar's choices on <html>, where the stylesheet reads them; freezes animation so screenshots are stable. */
function Appearance({
  globals,
  children,
}: {
  globals: StoryContext['globals']
  children: React.ReactNode
}) {
  useEffect(() => {
    const root = document.documentElement
    const set = (name: string, value: string | undefined, fallback: string): void => {
      if (value && value !== fallback) root.setAttribute(name, value)
      else root.removeAttribute(name)
    }
    set('data-theme', globals.theme, 'system')
    set('data-accent', globals.accent, 'blue')
    set('data-glass', globals.glass, 'standard')
    root.setAttribute('data-no-anim', 'true')
  }, [globals.theme, globals.accent, globals.glass])
  return children
}

const preview: Preview = {
  parameters: {
    layout: 'centered',
    controls: { expanded: true },
    a11y: { test: 'todo' },
  },
  globalTypes: {
    theme: {
      description: 'Light or dark',
      toolbar: { title: 'Theme', icon: 'mirror', items: ['light', 'dark'], dynamicTitle: true },
    },
    accent: {
      description: 'Accent colour',
      toolbar: { title: 'Accent', icon: 'paintbrush', items: [...ACCENT_KEYS], dynamicTitle: true },
    },
    glass: {
      description: 'Glass level',
      toolbar: { title: 'Glass', icon: 'transfer', items: [...GLASS_KEYS], dynamicTitle: true },
    },
  },
  initialGlobals: { theme: 'light', accent: 'blue', glass: 'standard' },
  decorators: [
    (Story, context) => {
      const {
        api,
        route = '/',
        surface = 'plain',
      } = (context as unknown as StoryContext).parameters
      const client = useMemo(
        () =>
          new QueryClient({
            defaultOptions: {
              queries: {
                retry: false,
                staleTime: Number.POSITIVE_INFINITY,
                refetchOnWindowFocus: false,
              },
            },
          }),
        [],
      )
      // Installed while rendering, before any component of the story asks for data.
      useMemo(() => {
        if (api) installMockApi(api)
        else restoreFetch()
      }, [api])
      const router = useMemo(() => {
        const root = createRootRoute({ component: () => <Story /> })
        return createRouter({
          routeTree: root,
          history: createMemoryHistory({ initialEntries: [route] }),
        })
      }, [route, Story])
      const content = (
        <CSPProvider disableStyleElements>
          <QueryClientProvider client={client}>
            <MotionConfig reducedMotion="always">
              <TooltipProvider>
                <RouterProvider router={router as never} />
                <Toasts />
              </TooltipProvider>
            </MotionConfig>
          </QueryClientProvider>
        </CSPProvider>
      )
      return (
        <Appearance globals={(context as unknown as StoryContext).globals}>
          {surface === 'wallpaper' ? (
            <div
              className="window"
              style={{ minHeight: 360, minWidth: 360, width: '100%', height: '100%' }}
            >
              <Wallpaper />
              <div style={{ position: 'relative', zIndex: 1, padding: 24 }}>{content}</div>
            </div>
          ) : surface === 'plain' ? (
            <div
              style={{
                background: 'var(--bg-content)',
                color: 'var(--label)',
                padding: 24,
                borderRadius: 12,
              }}
            >
              {content}
            </div>
          ) : (
            content
          )}
        </Appearance>
      )
    },
  ],
}

export default preview
