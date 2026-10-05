import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { type CSSProperties, useId, useSyncExternalStore } from 'react'
import { Wallpaper } from '@/components/layout/wallpaper.tsx'
import { Button } from '@/components/ui/button.tsx'
import { SegmentedControl, Slider, Switch } from '@/components/ui/controls.tsx'
import { Icon } from '@/components/ui/icon.tsx'
import {
  ACCENT_KEYS,
  ACCENT_ON,
  type AccentKey,
  accents,
  type GlassLevelKey,
} from '@/design/tokens.ts'
import { type Theme, useAppearance } from '@/lib/appearance.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { getLocale, type locales, setLocale } from '@/paraglide/runtime.js'
import { Box, Group, Row } from './settings-ui.tsx'

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = matchMedia(query)
      list.addEventListener('change', notify)
      return () => list.removeEventListener('change', notify)
    },
    () => matchMedia(query).matches,
    () => false,
  )
}

/** Dark right now: the explicit choice, or the system's when the theme follows it. */
export function useIsDark(): boolean {
  const theme = useAppearance((state) => state.theme)
  const system = useMedia('(prefers-color-scheme: dark)')
  return theme === 'system' ? system : theme === 'dark'
}

function Preview() {
  return (
    <div className="preview" aria-hidden="true">
      <Wallpaper />
      <div className="preview__side glass squircle">
        <b>{m.settings_preview_title()}</b>
        <span className="text-label-secondary">{m.settings_preview_line()}</span>
      </div>
      <div className="preview__main">
        <span className="preview__bubble">{m.settings_preview_in()}</span>
        <span className="preview__bubble preview__bubble--out">{m.settings_preview_out()}</span>
      </div>
    </div>
  )
}

/** The accent colours' names in the interface language (the token table keeps only the Chinese names for the design notes). */
const ACCENT_NAMES: Record<AccentKey, () => string> = {
  blue: () => m.accent_blue(),
  purple: () => m.accent_purple(),
  pink: () => m.accent_pink(),
  red: () => m.accent_red(),
  orange: () => m.accent_orange(),
  yellow: () => m.accent_yellow(),
  green: () => m.accent_green(),
  graphite: () => m.accent_graphite(),
}

function sizeText(step: number): string {
  if (step === 0) return m.settings_type_default()
  return step > 0 ? m.settings_type_plus({ step }) : m.settings_type_minus({ step: -step })
}

export function AppearanceSection() {
  const appearance = useAppearance()
  const dark = useIsDark()
  const reducedTransparency = useMedia('(prefers-reduced-transparency: reduce)')
  const reducedMotion = useMedia('(prefers-reduced-motion: reduce)')
  const sizeId = useId()
  const dim = dark ? 1 : 0
  const glassItems: { value: GlassLevelKey; label: string }[] = [
    { value: 'clear', label: m.settings_glass_clear() },
    { value: 'standard', label: m.settings_glass_standard() },
    { value: 'tinted', label: m.settings_glass_tinted() },
    { value: 'opaque', label: m.settings_glass_opaque() },
  ]

  return (
    <>
      <Preview />
      <Group title={m.settings_theme()}>
        <Box>
          <Row title={m.settings_theme_mode()} help={m.settings_theme_mode_help()}>
            <SegmentedControl<Theme>
              label={m.settings_theme_mode()}
              value={appearance.theme}
              onValueChange={(value) => appearance.set('theme', value)}
              items={[
                { value: 'light', label: m.settings_theme_light(), icon: Sun },
                { value: 'dark', label: m.settings_theme_dark(), icon: Moon },
                { value: 'system', label: m.settings_theme_system(), icon: Monitor },
              ]}
            />
          </Row>
        </Box>
      </Group>
      <Group title={m.settings_accent()}>
        <div className="group__box p-3.5">
          <RadioGroup
            className="swatches"
            aria-label={m.settings_accent()}
            value={appearance.accent}
            onValueChange={(value) => appearance.set('accent', value as typeof appearance.accent)}
          >
            {ACCENT_KEYS.map((key) => (
              <Radio.Root
                key={key}
                value={key}
                className="swatch"
                aria-label={ACCENT_NAMES[key]()}
                nativeButton
                render={<button type="button" />}
                style={
                  {
                    '--sw': accents[key].solid[dim],
                    '--sw-on': ACCENT_ON[dim],
                  } as CSSProperties
                }
              >
                <Icon icon={Check} strokeWidth={2.4} />
              </Radio.Root>
            ))}
          </RadioGroup>
          <p className="mt-2.5 text-subheadline text-label-secondary">{m.settings_accent_help()}</p>
        </div>
      </Group>
      <Group title={m.settings_glass()}>
        <Box>
          <Row
            title={m.settings_glass_material()}
            help={reducedTransparency ? m.settings_glass_system_off() : m.settings_glass_help()}
          >
            <SegmentedControl<GlassLevelKey>
              label={m.settings_glass_material()}
              value={reducedTransparency ? 'opaque' : appearance.glass}
              disabled={reducedTransparency}
              onValueChange={(value) => appearance.set('glass', value)}
              items={glassItems}
            />
          </Row>
        </Box>
      </Group>
      <Group title={m.settings_text_motion()}>
        <Box>
          <Row title={m.settings_type_size()} help={m.settings_type_size_help()} htmlFor={sizeId}>
            <div className="size-row w-[260px] max-w-[50vw]">
              <span className="text-subheadline" aria-hidden="true">
                A
              </span>
              <Slider
                id={sizeId}
                min={-1}
                max={3}
                value={appearance.typeSize}
                label={m.settings_type_size()}
                valueText={sizeText(appearance.typeSize)}
                onValueChange={(value) => appearance.set('typeSize', value)}
              />
              <span className="text-title-3" aria-hidden="true">
                A
              </span>
            </div>
          </Row>
          <Row title={m.settings_type_size_current()}>
            <span className="min-w-[3.5em] text-right text-callout tabular-nums">
              {sizeText(appearance.typeSize)}
            </span>
          </Row>
          <Row
            title={m.settings_reduce_motion()}
            help={
              reducedMotion ? m.settings_reduce_motion_system() : m.settings_reduce_motion_help()
            }
            titleId={`${sizeId}-motion`}
          >
            <Switch
              labelledBy={`${sizeId}-motion`}
              checked={appearance.reduceMotion || reducedMotion}
              disabled={reducedMotion}
              onCheckedChange={(value) => appearance.set('reduceMotion', value)}
            />
          </Row>
          <Row
            title={m.settings_sidebar_preview()}
            help={m.settings_sidebar_preview_help()}
            titleId={`${sizeId}-preview`}
          >
            <Switch
              labelledBy={`${sizeId}-preview`}
              checked={!appearance.compactSidebar}
              onCheckedChange={(value) => appearance.set('compactSidebar', !value)}
            />
          </Row>
          <Row
            title={m.settings_timeline_paged()}
            help={m.settings_timeline_paged_help()}
            titleId={`${sizeId}-paged`}
          >
            <Switch
              labelledBy={`${sizeId}-paged`}
              checked={appearance.timelineMode === 'paged'}
              onCheckedChange={(value) =>
                appearance.set('timelineMode', value ? 'paged' : 'virtual')
              }
            />
          </Row>
        </Box>
      </Group>
      <Group title={m.settings_language()}>
        <Box>
          <Row title={m.settings_language_label()} help={m.settings_language_help()}>
            <SegmentedControl<string>
              label={m.settings_language_label()}
              value={getLocale()}
              onValueChange={(value) => void setLocale(value as (typeof locales)[number])}
              items={[
                { value: 'zh-CN', label: '简体中文' },
                { value: 'en', label: 'English' },
              ]}
            />
          </Row>
        </Box>
      </Group>
      <div>
        <Button
          kind="tinted"
          onClick={() => {
            appearance.reset()
            showToast(m.settings_reset_done())
          }}
        >
          {m.settings_reset()}
        </Button>
      </div>
    </>
  )
}
