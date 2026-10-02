import type { StorybookConfig } from '@storybook/react-vite'

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y'],
  framework: '@storybook/react-vite',
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  viteFinal(viteConfig) {
    // Stories never use the file router, so its code generator stays out of Storybook.
    const keep = (plugin: unknown): boolean => {
      const name = (plugin as { name?: string } | null)?.name ?? ''
      return !name.startsWith('tanstack-router')
    }
    const flatten = (plugins: unknown[] | undefined): unknown[] =>
      (plugins ?? []).flatMap((plugin) => (Array.isArray(plugin) ? flatten(plugin) : [plugin]))
    return { ...viteConfig, plugins: flatten(viteConfig.plugins).filter(keep) as never }
  },
}

export default config
