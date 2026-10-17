/** Real components and sync engine; Playwright supplies synthetic HTTP responses. Never used by the product build. */
import { CSPProvider } from '@base-ui/react/csp-provider'
import { QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@/lib/zod-config.ts'
import '@/styles/app.css'
import { engine } from '@/app/sync.ts'
import { Toasts } from '@/components/ui/toasts.tsx'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { AdminPage } from '@/features/admin/admin-page.tsx'
import { ApprovalCard } from '@/features/agent/approval-card.tsx'
import { useAgent } from '@/features/agent/store.ts'
import { AgentUsage } from '@/features/agent/usage.tsx'
import { CommandPalette } from '@/features/command-palette/command-palette.tsx'
import { AssistantSection } from '@/features/settings/assistant-section.tsx'
import { MemoriesGroup } from '@/features/settings/memories-group.tsx'
import { AppFrame } from '@/features/shell/app-frame.tsx'
import { Welcome } from '@/features/shell/welcome.tsx'
import { startAppearance } from '@/lib/appearance.ts'
import { queryClient } from '@/lib/query-client.ts'
import { makeAccount, uuid } from '@/lib/sync/fixtures.ts'
import { approval, me, run } from './fixtures.ts'

queryClient.setDefaultOptions({
  queries: { retry: false, staleTime: 15000 },
  mutations: { retry: false },
})
queryClient.setQueryData(['me'], me)
startAppearance()
await engine.start(me)
Object.assign(window, {
  review: {
    refreshUsage: () => queryClient.refetchQueries({ queryKey: ['agent-usage'] }),
    switchAccount: () => engine.start(makeAccount({ id: uuid(99), restoreEpoch: 'review' })),
  },
})
function Stage() {
  const [open, setOpen] = useState(true)
  const mode = new URLSearchParams(location.search).get('mode')
  if (mode === 'memories') return <MemoriesGroup />
  if (mode === 'approval') return <ApprovalCard approval={approval} run={run} effect={undefined} />
  if (mode === 'usage') return <AgentUsage />
  if (mode === 'tasks') return <AssistantSection me={me} />
  if (mode === 'admin') return <AdminPage />
  if (mode === 'palette')
    return (
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        commands={Array.from({ length: 35 }, (_, index) => ({
          id: String(index),
          label: `命令 ${index + 1}`,
          group: '测试',
          icon: Search,
          run: () => undefined,
        }))}
      />
    )
  return (
    <AppFrame
      me={me}
      settings={undefined}
      onSettingsChange={() => undefined}
      onSignOut={() => undefined}
    >
      <Welcome name="Alice" />
    </AppFrame>
  )
}
const root = createRootRoute({ component: Stage })
const router = createRouter({
  routeTree: root.addChildren([
    createRoute({ getParentRoute: () => root, path: '/', component: () => null }),
    createRoute({ getParentRoute: () => root, path: '/channels', component: () => null }),
    createRoute({ getParentRoute: () => root, path: '/c/$conversationId', component: () => null }),
  ]),
  history: createMemoryHistory({ initialEntries: ['/'] }),
})
Object.assign(window, {
  reviewNavigation: {
    path: () => router.state.location.pathname,
    jump: (id: string) => useAgent.getState().jumps[id],
  },
})
const shell = new URLSearchParams(location.search).get('mode') === 'shell'
const host = document.getElementById('root')
if (!host) throw new Error('Regression fixture root missing')
createRoot(host).render(
  <CSPProvider disableStyleElements>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {shell ? (
          <RouterProvider router={router} />
        ) : (
          <main style={{ minHeight: '100vh', padding: 24 }}>
            <RouterProvider router={router} />
          </main>
        )}
        <Toasts />
      </TooltipProvider>
    </QueryClientProvider>
  </CSPProvider>,
)
