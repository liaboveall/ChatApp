import { type Me, pushSubscriptionListSchema } from '@chatapp/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Send } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import {
  disablePushHere,
  type EnableResult,
  enablePushHere,
  removePushDevice,
  sendTestPush,
} from '@/app/push.ts'
import { forScreen } from '@/app/sync.ts'
import { Button } from '@/components/ui/button.tsx'
import { Switch } from '@/components/ui/controls.tsx'
import { Banner, Skeleton } from '@/components/ui/feedback.tsx'
import { api } from '@/lib/api.ts'
import { installationId } from '@/lib/push/installation.ts'
import { notificationPermission, type PushSupport, pushSupport } from '@/lib/push/support.ts'
import { isInstalledApp, promptInstall, useInstall } from '@/lib/pwa/install.ts'
import { currentRegistration } from '@/lib/pwa/register.ts'
import { useSyncScope } from '@/lib/sync/hooks.ts'
import { relativeTime } from '@/lib/time-format.ts'
import { showToast } from '@/lib/toast.ts'
import { useTime } from '@/lib/use-time.ts'
import { describeUserAgent, deviceTitle } from '@/lib/user-agent.ts'
import { m } from '@/paraglide/messages.js'
import { Box, Group, Row } from './settings-ui.tsx'
import { useMeSettings } from './use-me-settings.ts'

function unsupportedText(support: Extract<PushSupport, { supported: false }>): string {
  switch (support.reason) {
    case 'insecure':
      return m.push_unsupported_insecure()
    case 'no-service-worker':
      return m.push_unsupported_no_service_worker()
    case 'no-push':
      return m.push_unsupported_no_push()
    case 'no-notifications':
      return m.push_unsupported_no_notifications()
    case 'needs-install':
      return m.push_unsupported_needs_install()
    case 'no-storage':
      return m.push_unsupported_no_storage()
  }
}

/** What to tell the person about how turning push on went; nothing for a result that is not for them any more. */
function enableText(result: EnableResult): string | null {
  switch (result) {
    case 'enabled':
      return m.push_enabled_toast()
    case 'denied':
      return m.push_here_help_denied()
    case 'dismissed':
      return m.push_dismissed()
    case 'no-worker':
      return m.push_no_worker()
    case 'refused':
      return m.push_refused()
    case 'session-changed':
      return null
    default:
      return m.push_failed()
  }
}

function enableToast(result: EnableResult): void {
  const text = enableText(result)
  if (text !== null) showToast(text)
}

/** The subscriptions of the account, as the server knows them; the one of this installation is marked `current`. */
function useDevices() {
  const scope = useSyncScope()
  return useQuery({
    queryKey: ['push-devices', scope?.userId, scope?.generation],
    enabled: scope !== null,
    queryFn: () =>
      forScreen(null, () =>
        api(`/api/push/subscriptions?installationId=${installationId()}`, {
          schema: pushSubscriptionListSchema,
        }),
      ),
  })
}

function DeviceGroup({ me }: { me: Me }) {
  const id = useId()
  const queryClient = useQueryClient()
  const devices = useDevices()
  const support = pushSupport()
  const [subscribedHere, setSubscribedHere] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  // What this browser itself holds, which the server cannot know.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const registration = await currentRegistration()
      const subscription = await registration?.pushManager.getSubscription()
      if (!cancelled) setSubscribedHere(subscription !== null && subscription !== undefined)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const known = devices.data?.subscriptions.some((entry) => entry.current) ?? false
  const enabled = subscribedHere === true && known
  const denied = notificationPermission() === 'denied'

  const refresh = async (): Promise<void> => {
    const registration = await currentRegistration()
    const subscription = await registration?.pushManager.getSubscription()
    setSubscribedHere(subscription !== null && subscription !== undefined)
    await queryClient.invalidateQueries({ queryKey: ['push-devices'] })
  }

  const toggle = async (next: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (next) {
        enableToast(await enablePushHere(me.id))
      } else {
        const told = await disablePushHere()
        showToast(told ? m.push_disabled_toast() : m.push_disable_partial())
      }
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const help = !support.supported
    ? unsupportedText(support)
    : denied && !enabled
      ? m.push_here_help_denied()
      : enabled
        ? m.push_here_help_on()
        : m.push_here_help_off()

  return (
    <Group title={m.push_group_device()}>
      <Box>
        <Row title={m.push_here()} help={help} titleId={`${id}-here`}>
          {devices.isPending || subscribedHere === null ? (
            <Skeleton width={44} height={26} />
          ) : (
            <Switch
              labelledBy={`${id}-here`}
              checked={enabled}
              disabled={!support.supported || busy || (denied && !enabled)}
              onCheckedChange={(next) => void toggle(next)}
            />
          )}
        </Row>
        <Row title={m.push_test()} help={m.push_test_help()}>
          <Button
            kind="tinted"
            size="sm"
            icon={Send}
            disabled={!enabled || busy}
            onClick={() =>
              void sendTestPush().then((queued) =>
                showToast(queued ? m.push_test_sent() : m.push_test_none()),
              )
            }
          >
            {m.push_test()}
          </Button>
        </Row>
      </Box>
    </Group>
  )
}

function AccountGroup({ me }: { me: Me }) {
  const id = useId()
  const save = useMeSettings(me)
  const master = me.settings.pushEnabled !== false
  return (
    <Group title={m.push_group_account()}>
      <Box>
        <Row title={m.push_master()} help={m.push_master_help()} titleId={`${id}-master`}>
          <Switch
            labelledBy={`${id}-master`}
            checked={master}
            disabled={save.isPending}
            onCheckedChange={(pushEnabled) => save.mutate({ pushEnabled })}
          />
        </Row>
        <Row title={m.push_assistant()} help={m.push_assistant_help()} titleId={`${id}-assistant`}>
          <Switch
            labelledBy={`${id}-assistant`}
            checked={me.settings.pushAssistant !== false}
            disabled={save.isPending || !master}
            onCheckedChange={(pushAssistant) => save.mutate({ pushAssistant })}
          />
        </Row>
        <Row title={m.push_preview()} help={m.push_preview_help()} titleId={`${id}-preview`}>
          <Switch
            labelledBy={`${id}-preview`}
            checked={me.settings.pushPreview === true}
            disabled={save.isPending || !master}
            onCheckedChange={(pushPreview) => save.mutate({ pushPreview })}
          />
        </Row>
      </Box>
      <p className="row__help px-1 pt-2">{m.push_levels_help()}</p>
    </Group>
  )
}

function OtherDevicesGroup() {
  const devices = useDevices()
  const queryClient = useQueryClient()
  const { locale, now } = useTime()
  const others = devices.data?.subscriptions.filter((entry) => !entry.current) ?? []
  return (
    <Group title={m.push_other_devices()}>
      <Box>
        {devices.isPending ? (
          <Row title={<Skeleton width={160} />} />
        ) : others.length === 0 ? (
          <Row title={m.push_other_devices_empty()} />
        ) : (
          others.map((entry) => {
            const name = deviceTitle(describeUserAgent(entry.userAgent), m.push_device_unknown())
            return (
              <Row
                key={entry.id}
                title={name}
                help={m.push_device_added({ when: relativeTime(entry.createdAt, now(), locale) })}
              >
                <Button
                  kind="plain"
                  size="sm"
                  aria-label={m.push_device_remove_label({ name })}
                  onClick={() =>
                    void removePushDevice(entry.id).then(async (done) => {
                      if (done) showToast(m.push_device_removed())
                      await queryClient.invalidateQueries({ queryKey: ['push-devices'] })
                    })
                  }
                >
                  {m.push_device_remove()}
                </Button>
              </Row>
            )
          })
        )}
      </Box>
    </Group>
  )
}

function InstallGroup() {
  const offer = useInstall((state) => state.offer)
  const installedNow = useInstall((state) => state.installed)
  const installed = isInstalledApp() || installedNow
  return (
    <Group title={m.install_group()}>
      <Box>
        {installed ? (
          <Row title={m.install_done()} />
        ) : offer ? (
          <Row title={m.install_app()} help={m.install_help()}>
            <Button
              kind="tinted"
              size="sm"
              icon={Download}
              onClick={() =>
                void promptInstall().then((accepted) => {
                  if (!accepted) showToast(m.install_failed_toast())
                })
              }
            >
              {m.install_app()}
            </Button>
          </Row>
        ) : (
          <Row title={m.install_app()} help={m.install_manual()} />
        )}
      </Box>
    </Group>
  )
}

/** Settings → Notifications: push for this device, what is pushed, the other devices, installing the app (docs/01 section 4.10). */
export function NotificationsSection({ me }: { me: Me }) {
  return (
    <>
      <DeviceGroup me={me} />
      <AccountGroup me={me} />
      <OtherDevicesGroup />
      <InstallGroup />
      <Banner tone="info">{m.push_network_note()}</Banner>
    </>
  )
}
