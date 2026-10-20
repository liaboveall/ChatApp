<p align="center">
  <img src="apps/web/public/icons/icon-192.png" alt="ChatApp icon" width="80" height="80">
</p>

<h1 align="center">ChatApp</h1>
<p align="center"><strong>Your conversations. Your context. Your Agent.</strong></p>
<p align="center">An invite-only place to chat, share files, and turn conversations into action with a built-in AI Agent.</p>
<p align="center">
  <a href="https://chatapp.software">Open ChatApp</a> ·
  <a href="#product-demo">Product demo</a> ·
  <a href="#meet-your-agent">Meet the Agent</a> ·
  <a href="#run-locally">Run locally</a> ·
  <a href="docs/00-overview.md">Documentation</a>
</p>

![ChatApp: a team conversation alongside a private Agent summarizing decisions and next steps](docs/assets/demo/02-agent-panel.png)

ChatApp brings channels, groups, direct messages, and a tool-using Agent into one workspace. Catch up on a discussion, find a decision, draft a reply, and review the Agent's proposed actions without leaving the conversation. A glass-inspired interface, light and dark themes, English and Chinese, and an installable PWA make it feel at home on your desktop.

## Product demo

A small team is preparing a product launch. Alice, Bob, and Maya discuss the plan, share a checklist, and use the Agent to turn the discussion into a clear update.

![Animated product tour: team chat, the Agent panel, an approval request, shared files, and dark mode](docs/assets/demo/product-tour.gif)

1. **Talk it through.** Keep the launch discussion, owners, and checklist in a group conversation.
2. **Ask the Agent.** Open the private side panel for a recap of decisions and next steps.
3. **Turn context into a draft.** Use a dedicated assistant chat to find the launch discussion and prepare an update.
4. **Review the action.** Inspect the destination and message, then approve, edit, or reject the proposed send.
5. **Keep everything close.** Browse shared files, open the command palette, or switch to dark mode.

[Explore the full screenshot tour and example prompts →](docs/demo.md)

*All captures show the actual English web client with fictional people and browser-local demo responses. Agent answers and approval outcomes are scripted for presentation; this tour does not make live AI calls or send real messages. Access to the hosted app requires an invitation.*

## Meet your Agent

The Agent can work with the conversations you have access to, use tools to retrieve context, and propose actions for you to review.

### Get help where the conversation happens

- **Private side panel:** summarize unread messages, translate, and draft replies alongside the discussion. Answers stay private; insert a draft into the composer when you want to share it.
- **Dedicated assistant chats:** keep separate conversations with the Agent and ask questions across your accessible chats.
- **Shared `@Agent` replies:** mention the Agent in a group or channel so everyone there can see its answer.
- **Quick commands:** reach the assistant through the command palette or `/summary`, `/translate`, and `/draft`.

Choose **Fast** or **Deep** reasoning, watch answers stream in, and stop a running response. Eligible completed replies can be regenerated. The side panel defaults to **Current conversation**; expanding to **All accessible conversations** is an explicit choice.

### From a discussion to an answer

> “Summarize the launch decisions and next steps.”
>
> “Find the launch discussion and draft a short update with an owner for each task.”
>
> “What does this screenshot show?”

The Agent can search messages, read relevant conversation history, summarize, translate, draft, and analyze selected images. Semantic retrieval can find related discussions beyond exact keyword matches when embeddings are configured. **View tool steps** lets you inspect the tools used for a reply.

### You approve actions that affect other people

> “Send that update to Product launch.”

Before sending or scheduling a message, creating a group, or inviting members, the Agent shows an approval card. Review the target and content, make changes, or reject the request.

![The Agent asks Alice to approve, edit, or reject an update to Product launch](docs/assets/demo/03-agent-approval.png)

Personal reminders and explicitly requested memories can be created directly, with visible results and a way to undo them. Scheduling confirmations include the date and time zone. Manage reminders, scheduled messages, and memories in **Settings → Assistant**.

### Personal, with clear boundaries

Use the site's AI allowance or bring your own **DeepSeek API key**. See your usage, choose your preferred reasoning mode, and review or delete saved memories.

The Agent follows conversation access rules, including the boundary on history from before you joined. Shared `@Agent` replies use the current conversation's shared visible history and do not load your personal memories. Site-key run content can be audited by administrators during its retention period; personal-key run content is restricted to its owner. Relevant content is sent to the configured AI provider, so review its answers before relying on them.

AI availability, image understanding, and semantic retrieval depend on the instance's provider and embedding configuration. See the [Agent design](docs/06-agent.md) for the full behavior and privacy rules.

## More than an assistant

| Feature | What you can do |
| --- | --- |
| **Channels, groups, and DMs** | Discover channels, create private groups, and message community members directly. Pin conversations and control notifications. |
| **Everyday messaging** | Write Markdown, reply with context, mention people, edit or recall messages within the allowed window, and retry failed sends. |
| **Files and media** | Drag, paste, or upload images, videos, audio, and files. Preview media, download attachments, and browse shared files. |
| **Stay in sync** | See presence, typing indicators, and unread counts, with reconnect catch-up and synchronization across tabs and devices. |
| **Find your way quickly** | Search messages, jump between conversations, and run commands from the keyboard. Ordinary keyword search uses no AI allowance. |
| **Make it yours** | Choose light or dark, accent colors, glass effects, text size, and English or Chinese. Install the desktop PWA. |
| **Notifications** | Use the notification center and, when configured and permitted, browser push for DMs, mentions, replies, and Agent approvals. |
| **Community controls** | Invite members, use passkeys, manage signed-in devices, report messages, and administer roles, moderation, audit logs, and AI budgets. |

<table>
  <tr>
    <td width="50%"><img src="docs/assets/demo/01-workspace.png" alt="English team conversation with a shared PDF checklist"><br><strong>A shared workspace</strong> — conversations, unread messages, and files.</td>
    <td width="50%"><img src="docs/assets/demo/08-dark-mode.png" alt="The same English conversation in dark mode"><br><strong>Your preferred look</strong> — glass-inspired surfaces in light and dark.</td>
  </tr>
  <tr>
    <td><img src="docs/assets/demo/05-shared-files.png" alt="Conversation details with shared files and members"><br><strong>Context at hand</strong> — files and members beside the conversation.</td>
    <td><img src="docs/assets/demo/07-command-palette.png" alt="English command palette for conversation navigation and actions"><br><strong>Keyboard friendly</strong> — search, navigation, and actions in one place.</td>
  </tr>
</table>

## Run locally

Requires **Bun 1.4.2**, **Node.js 24+** (CI uses 26), and **Docker Compose**. On Windows, use WSL with the repository in the Linux filesystem and Docker Desktop's WSL integration enabled.

```bash
git clone https://github.com/liaboveall/ChatApp.git
cd ChatApp
bun install --frozen-lockfile
bun run setup
bun run infra:up
bun run infra:bootstrap
bun run db:migrate
bun run db:seed
bun run admin:create
bun run dev
```

Open the address printed after `[dev] Open` (normally `http://localhost:5173`). Development email is available in Mailpit at `http://localhost:8025`.

`setup` creates ignored local configuration and secrets. `db:seed` is for development data. Configure AI credentials locally and check the connection with `bun run doctor --ai`. Production uses separate configuration and `db:bootstrap`; follow the [deployment guide](docs/10-deployment.md).

## Built with

| Layer | Technologies |
| --- | --- |
| Web / PWA | React, Vite, TanStack Router / Query, Tailwind CSS, Base UI |
| API and Agent | TypeScript, Bun, Hono, Zod, Better Auth, AI SDK |
| Data and jobs | PostgreSQL / pgvector, Drizzle, Valkey, BullMQ |
| Files and media | Garage (S3), isolated media processing service |
| Deployment | Docker Compose, Nginx, encrypted offsite backups, systemd |

Dependency versions are pinned in the workspace manifests, `bun.lock`, and infrastructure image definitions.

## Development and documentation

| Command | Purpose |
| --- | --- |
| `bun run check` | Formatting, types, architecture boundaries, unit tests, contrast, and translation consistency |
| `bun run build` | Build the production web client |
| `bun run test:integration` | Integration tests with real database, cache, and object storage |
| `bun run test:e2e` | Browser tests against real local services |
| `bun run test:review` | Component browser regressions |
| `bun run test:visual` | Storybook visual regressions |
| `bun run storybook` | Component development and previews |
| `bun run demo:capture` | Refresh the English README screenshots with isolated demo fixtures |
| `bun run doctor` | Diagnose the local environment and services |

Integration and end-to-end tests need a prepared test environment. Suites that share a test database must run serially; see the [testing guide](docs/08-testing.md).

```text
apps/web/           Web / PWA client, components, and browser tests
apps/server/        API, WebSocket, background jobs, Agent, admin CLI, and evals
apps/media/         Isolated media processing service
packages/contracts/ Shared validation and protocols
packages/db/        Data models, migrations, bootstrap, and development seeds
infra/              Compose, images, Nginx, and systemd templates
scripts/            Development, testing, release, backup, and diagnostic tools
docs/               Product, engineering, and operations documentation
```

[Product tour](docs/demo.md) · [Local development](docs/09-local-dev.md) · [Architecture](docs/03-architecture.md) · [Agent](docs/06-agent.md) · [Security](docs/07-security.md) · [Deployment](docs/10-deployment.md) · [Operations](docs/operations.md) · [Documentation index](docs/00-overview.md)

The product tour is in English; the detailed engineering documentation is primarily in Chinese.

## History and license

`main` is the current maintenance branch (previously `v2`). The original Django + Channels application is preserved in [`archive/v1`](https://github.com/liaboveall/ChatApp/tree/archive/v1) and the [`v1-legacy` tag](https://github.com/liaboveall/ChatApp/tree/v1-legacy). Earlier plans, reviews, milestone reports, and design prototypes are preserved in [`v2-pre-cleanup-2026-10-20`](https://github.com/liaboveall/ChatApp/tree/v2-pre-cleanup-2026-10-20). See the [maintenance notes](docs/maintenance.md).

[MIT](LICENSE). The original version was adapted from [rustyxlol/Django-ChatApp](https://github.com/rustyxlol/Django-ChatApp); its attribution is retained in the license.
