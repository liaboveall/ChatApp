import type { UserSummary } from '@chatapp/contracts'
import { createContext } from 'react'
export const MentionContext = createContext<{
  users: Record<string, UserSummary>
  meId: string
  valid: string[]
}>({ users: {}, meId: '', valid: [] })
