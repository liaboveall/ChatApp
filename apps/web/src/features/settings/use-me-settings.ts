import { type Me, meSchema, type PatchMeRequest } from '@chatapp/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { forScreen } from '@/app/sync.ts'
import { ApiError, api } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { queryKeys, writeMeAnswer } from '@/lib/queries.ts'
import { showToast } from '@/lib/toast.ts'

export type MeSettingsChange = NonNullable<PatchMeRequest['settings']>

/** Saves keys of my own settings (merged one by one on the server); a stale version re-reads the account and says so. */
export function useMeSettings(me: Me) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (settings: MeSettingsChange) =>
      forScreen(null, () =>
        api('/api/me', {
          method: 'PATCH',
          json: { expectedMeVersion: me.meVersion, settings },
          schema: meSchema,
        }),
      ),
    onSuccess: (updated) => {
      if (updated === null) return
      writeMeAnswer(queryClient, updated)
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT')
        await queryClient.invalidateQueries({ queryKey: queryKeys.me })
      showToast(describeError(error))
    },
  })
}
