import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { AppIcon } from '@/components/brand/app-icon.tsx'
import { Button } from '@/components/ui/button.tsx'
import { NewAgentChat } from '@/features/agent/new-chat.tsx'
import { NewConversationDialog } from '@/features/conversations/new-conversation-dialog.tsx'
import { m } from '@/paraglide/messages.js'
import { ShortcutRows } from './shortcuts-dialog.tsx'

/** The empty main panel: nothing is open yet. */
export function Welcome({ name }: { name: string }) {
  const navigate = useNavigate()
  const [dmOpen, setDmOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  return (
    <div className="welcome">
      <AppIcon size={72} />
      <h1 className="text-title-1">{m.welcome_title({ name })}</h1>
      <p className="max-w-[44ch] text-body text-label-secondary text-balance">{m.welcome_text()}</p>
      <div className="welcome__actions">
        <Button onClick={() => setDmOpen(true)}>{m.sidebar_new_dm()}</Button>
        <Button kind="tinted" onClick={() => void navigate({ to: '/channels' })}>
          {m.sidebar_browse()}
        </Button>
        <Button kind="tinted" onClick={() => setAgentOpen(true)}>
          {m.agent_new()}
        </Button>
      </div>
      <details className="welcome__keys">
        <summary>{m.welcome_shortcuts()}</summary>
        <ShortcutRows />
      </details>
      <NewConversationDialog kind={dmOpen ? 'dm' : null} onOpenChange={setDmOpen} />
      <NewAgentChat open={agentOpen} onOpenChange={setAgentOpen} />
    </div>
  )
}
