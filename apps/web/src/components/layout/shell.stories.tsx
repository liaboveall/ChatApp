import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect } from 'react'
import { Welcome } from '@/features/shell/welcome.tsx'
import { type InspectorTab, useShell } from '@/lib/shell-state.ts'
import { sampleMe } from '../../../.storybook/mock-api.ts'
import { AppShell } from './app-shell.tsx'
import { Inspector } from './inspector.tsx'
import { Sidebar } from './sidebar.tsx'
import { Toolbar } from './toolbar.tsx'

const meta = {
  title: 'Layout/App shell',
  tags: ['visual'],
  parameters: { layout: 'fullscreen', surface: 'none' },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

function Shell({ width, inspector }: { width: number | string; inspector: InspectorTab | null }) {
  useEffect(() => {
    useShell.setState({ inspector, drawerOpen: false })
  }, [inspector])
  const noop = () => {}
  return (
    <div style={{ width, height: 760, position: 'relative' }}>
      <AppShell
        sidebar={<Sidebar me={sampleMe} onOpenPalette={noop} onOpenSettings={noop} />}
        toolbar={
          <Toolbar
            title="ChatApp"
            assistantOpen={inspector === 'assistant'}
            onToggleAssistant={noop}
            onOpenDrawer={noop}
            onOpenPalette={noop}
            onOpenSettings={noop}
            onOpenShortcuts={noop}
          />
        }
        inspector={<Inspector />}
      >
        <Welcome name={sampleMe.displayName} />
      </AppShell>
    </div>
  )
}

export const Desktop: Story = { render: () => <Shell width={1440} inspector={null} /> }
export const DockedAssistantPanel: Story = {
  render: () => <Shell width={1440} inspector="assistant" />,
}
export const InspectorFloatsOverContent: Story = {
  render: () => <Shell width={1100} inspector="details" />,
}
export const SidebarAsRail: Story = { render: () => <Shell width={900} inspector={null} /> }
export const SingleColumn: Story = { render: () => <Shell width={420} inspector={null} /> }
