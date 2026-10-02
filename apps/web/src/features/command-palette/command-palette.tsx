import { Dialog } from '@base-ui/react/dialog'
import type { LucideIcon } from 'lucide-react'
import { Search } from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  useDeferredValue,
  useId,
  useMemo,
  useState,
} from 'react'
import { useModalFlag } from '@/components/ui/dialog.tsx'
import { Icon } from '@/components/ui/icon.tsx'
import { keyLabel } from '@/lib/platform.ts'
import { m } from '@/paraglide/messages.js'

export type PaletteCommand = {
  id: string
  label: string
  /** Second line, for example the section it opens. */
  sub?: string
  group: string
  icon: LucideIcon
  /** Extra words that should find this command. */
  keywords?: string
  /** Keys of the shortcut, shown at the right. */
  keys?: string[]
  run: () => void
}

type CommandPaletteProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  commands: PaletteCommand[]
}

/** Case-insensitive substring match; returns the matched range for highlighting, or null. */
export function findMatch(text: string, query: string): [number, number] | null {
  const at = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
  return at < 0 ? null : [at, at + query.length]
}

function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const range = query ? findMatch(text, query) : null
  if (!range) return text
  return (
    <>
      {text.slice(0, range[0])}
      <mark className="hl">{text.slice(range[0], range[1])}</mark>
      {text.slice(range[1])}
    </>
  )
}

/**
 * ⌘K: jump to a setting or run a command. A modal combobox: the input keeps focus and moves the active option with the
 * arrow keys (aria-activedescendant), Enter runs it, Escape closes.
 */
export function CommandPalette({ open, onOpenChange, commands }: CommandPaletteProps) {
  useModalFlag(open)
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="scrim" />
        <Dialog.Viewport className="palette-host">
          <Dialog.Popup className="palette glass-text squircle" aria-label={m.palette_title()}>
            <PaletteBody commands={commands} onDone={() => onOpenChange(false)} />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function PaletteBody({ commands, onDone }: { commands: PaletteCommand[]; onDone: () => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const deferred = useDeferredValue(query)
  const listId = useId()

  const results = useMemo(() => {
    const needle = deferred.trim()
    if (!needle) return commands
    return commands.filter(
      (command) =>
        findMatch(command.label, needle) ||
        findMatch(command.sub ?? '', needle) ||
        findMatch(command.keywords ?? '', needle),
    )
  }, [commands, deferred])

  const current = results[Math.min(active, results.length - 1)]
  const optionId = (index: number): string => `${listId}-${index}`

  const run = (command: PaletteCommand | undefined): void => {
    if (!command) return
    onDone()
    command.run()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((value) => (results.length === 0 ? 0 : (value + 1) % results.length))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((value) =>
        results.length === 0 ? 0 : (value - 1 + results.length) % results.length,
      )
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActive(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActive(Math.max(0, results.length - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      run(current)
    }
  }

  let lastGroup = ''
  return (
    <>
      <div className="palette__head">
        <Icon icon={Search} size={20} />
        <input
          // biome-ignore lint/a11y/noAutofocus: the palette exists to be typed into the moment it opens.
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={current ? optionId(results.indexOf(current)) : undefined}
          aria-autocomplete="list"
          aria-label={m.palette_title()}
          placeholder={m.palette_placeholder()}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div
        className="palette__list scroll"
        id={listId}
        role="listbox"
        aria-label={m.palette_title()}
      >
        {results.length === 0 ? (
          <div className="palette__group" role="presentation">
            {m.palette_empty()}
          </div>
        ) : null}
        {results.map((command, index) => {
          const heading = command.group !== lastGroup ? command.group : null
          lastGroup = command.group
          return (
            <div key={command.id} role="presentation">
              {heading ? (
                <div className="palette__group" role="presentation">
                  {heading}
                </div>
              ) : null}
              <button
                type="button"
                id={optionId(index)}
                role="option"
                tabIndex={-1}
                aria-selected={command === current}
                className="palette__row"
                data-active={command === current ? 'true' : 'false'}
                onMouseMove={() => setActive(index)}
                onClick={() => run(command)}
              >
                <span className="palette__icon">
                  <Icon icon={command.icon} size={18} />
                </span>
                <span className="palette__main">
                  <span className="palette__label">
                    <Highlight text={command.label} query={deferred.trim()} />
                  </span>
                  {command.sub ? <span className="palette__sub">{command.sub}</span> : null}
                </span>
                {command.keys ? (
                  <span className="palette__hint">
                    {command.keys.map((key) => (
                      <kbd key={key}>{keyLabel(key)}</kbd>
                    ))}
                  </span>
                ) : null}
              </button>
            </div>
          )
        })}
      </div>
      <div className="palette__foot">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> {m.palette_hint_move()} <kbd>↵</kbd> {m.palette_hint_run()}
        </span>
        <span>
          <kbd>Esc</kbd> {m.palette_hint_close()}
        </span>
      </div>
    </>
  )
}
