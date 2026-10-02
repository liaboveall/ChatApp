// Sample content for the prototype. Everything here is invented. Times are fixed strings so the
// page looks the same on any day; "today" is Friday 2 October 2026.

export const ME = 'me'

export const people = {
  me: { id: 'me', name: '周屿', username: 'zhouyu', hue: 250, status: 'online' },
  alice: { id: 'alice', name: 'Alice Chen', username: 'alice', hue: 345, status: 'online' },
  bob: { id: 'bob', name: 'Bob Lin', username: 'bob', hue: 160, status: 'away', seen: '5 分钟前' },
  carol: {
    id: 'carol',
    name: 'Carol Wu',
    username: 'carol',
    hue: 35,
    status: 'offline',
    seen: '23 分钟前',
  },
  xuqing: { id: 'xuqing', name: '许晴', username: 'xuqing', hue: 215, status: 'online' },
  laok: {
    id: 'laok',
    name: '老K',
    username: 'laok',
    hue: 295,
    status: 'offline',
    seen: '昨天 22:10',
  },
  dana: {
    id: 'dana',
    name: 'Dana Wei',
    username: 'dana_w',
    hue: 100,
    status: 'offline',
    seen: '3 天前',
  },
  bot: { id: 'bot', name: '助手', username: 'assistant', bot: true },
}

export const roles = { alice: '群主', bob: '管理员' }

// ---- Pictures (inline SVG, no files) ----

const svgUrl = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`

const SCENES = {
  uiLight: svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#e9eef9"/><rect x="18" y="18" width="364" height="264" rx="16" fill="#fff"/><rect x="18" y="18" width="96" height="264" rx="16" fill="#f1f3fa"/><g fill="#c9d3ec"><rect x="30" y="40" width="72" height="10" rx="5"/><rect x="30" y="64" width="60" height="10" rx="5"/><rect x="30" y="88" width="68" height="10" rx="5"/></g><rect x="134" y="52" width="150" height="34" rx="17" fill="#e9e9eb"/><rect x="226" y="98" width="132" height="34" rx="17" fill="#0066cc"/><rect x="134" y="144" width="190" height="34" rx="17" fill="#e9e9eb"/><rect x="258" y="190" width="100" height="34" rx="17" fill="#0066cc"/><rect x="134" y="242" width="224" height="26" rx="13" fill="#f1f3fa"/></svg>`,
  ),
  uiDark: svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#10121c"/><rect x="18" y="18" width="364" height="264" rx="16" fill="#1c1c1e"/><rect x="18" y="18" width="96" height="264" rx="16" fill="#26262c"/><g fill="#44464f"><rect x="30" y="40" width="72" height="10" rx="5"/><rect x="30" y="64" width="60" height="10" rx="5"/><rect x="30" y="88" width="68" height="10" rx="5"/></g><rect x="134" y="52" width="150" height="34" rx="17" fill="#3a3a3c"/><rect x="226" y="98" width="132" height="34" rx="17" fill="#0a84ff"/><rect x="134" y="144" width="190" height="34" rx="17" fill="#3a3a3c"/><rect x="258" y="190" width="100" height="34" rx="17" fill="#0a84ff"/><rect x="134" y="242" width="224" height="26" rx="13" fill="#2c2c2e"/></svg>`,
  ),
  mountains: svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd9b0"/><stop offset="1" stop-color="#9fc4f2"/></linearGradient></defs><rect width="400" height="300" fill="url(#s)"/><circle cx="290" cy="92" r="34" fill="#fff6e0"/><path d="M0 230 L90 130 L150 190 L230 100 L330 210 L400 160 V300 H0Z" fill="#5a79a8"/><path d="M0 262 L110 190 L190 240 L280 176 L400 250 V300 H0Z" fill="#35507a"/></svg>`,
  ),
  board: svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#f4f1ea"/><rect x="16" y="16" width="368" height="268" rx="10" fill="#fff" stroke="#d6d2c6" stroke-width="3"/><rect x="40" y="44" width="92" height="76" rx="4" fill="#ffe27a"/><rect x="152" y="60" width="92" height="76" rx="4" fill="#ffb3c8"/><rect x="264" y="40" width="92" height="76" rx="4" fill="#a9d4ff"/><path d="M60 190 C120 160 160 230 220 196 S320 180 350 214" fill="none" stroke="#6b6b76" stroke-width="4" stroke-linecap="round"/><g stroke="#9a9aa4" stroke-width="3" stroke-linecap="round"><path d="M52 66h50M52 84h38"/><path d="M164 82h50M164 100h30"/><path d="M276 62h50M276 80h40"/></g></svg>`,
  ),
  icons: svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#f1f1f6"/><defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5aa0ff"/><stop offset="1" stop-color="#3b3fd8"/></linearGradient><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9fcf"/><stop offset="1" stop-color="#7b4dff"/></linearGradient><linearGradient id="c" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7be0c3"/><stop offset="1" stop-color="#2b78e4"/></linearGradient></defs><rect x="24" y="86" width="104" height="104" rx="26" fill="url(#a)"/><rect x="148" y="86" width="104" height="104" rx="26" fill="url(#b)"/><rect x="272" y="86" width="104" height="104" rx="26" fill="url(#c)"/><g fill="#fff"><path d="M54 120h44a10 10 0 0 1 10 10v22a10 10 0 0 1-10 10H80l-14 12v-12h-12a10 10 0 0 1-10-10v-22a10 10 0 0 1 10-10Z" opacity=".95" transform="translate(-2 0)"/><circle cx="200" cy="138" r="22" opacity=".95"/><path d="M324 116l7 14 15 3-11 11 3 16-14-8-14 8 3-16-11-11 15-3Z" opacity=".95"/></g></svg>`,
  ),
}
export const scenes = SCENES

// ---- Conversations ----

export const conversations = [
  {
    id: 'dm-alice',
    kind: 'dm',
    person: 'alice',
    pinned: true,
    unread: 0,
    time: '昨天',
    last: '第二个最好看，能做深色版吗',
  },
  {
    id: 'ch-project',
    kind: 'channel',
    name: '项目组',
    pinned: true,
    unread: 3,
    mention: true,
    time: '10:31',
    last: 'Alice Chen：图标草案下午发',
    members: ['me', 'alice', 'bob', 'carol', 'xuqing', 'laok'],
    memberCount: 128,
    desc: '版本评审、迁移和每周进度都在这里',
    agent: true,
  },
  {
    id: 'ch-design',
    kind: 'channel',
    name: '设计',
    unread: 0,
    time: '昨天',
    last: '许晴：欢迎加入设计频道',
    members: ['me', 'alice', 'xuqing', 'laok'],
    memberCount: 42,
    desc: '界面、图标和设计规范',
    agent: true,
    joined: '10月1日 14:20',
  },
  {
    id: 'ch-random',
    kind: 'channel',
    name: '闲聊',
    unread: 12,
    muted: true,
    time: '10:18',
    last: '老K：中午吃什么',
    members: ['me', 'alice', 'bob', 'carol', 'xuqing', 'laok', 'dana'],
    memberCount: 311,
    desc: '随便聊聊',
    agent: true,
  },
  {
    id: 'ch-announce',
    kind: 'channel',
    name: '公告',
    unread: 0,
    time: '周三',
    last: '管理员：10 月邀请名额已更新',
    members: ['me', 'alice', 'bob', 'carol'],
    memberCount: 311,
    desc: '站点公告',
    agent: false,
  },
  {
    id: 'g-hike',
    kind: 'group',
    name: '周末徒步',
    unread: 1,
    time: '09:50',
    last: 'Carol Wu：周六 8:30 地铁口见',
    members: ['me', 'alice', 'bob', 'carol', 'xuqing', 'laok'],
    desc: '',
    agent: true,
  },
  {
    id: 'g-fam',
    kind: 'group',
    name: '家人',
    unread: 0,
    time: '周二',
    last: '妈妈：周末回家吃饭',
    members: ['me', 'alice', 'dana'],
    desc: '',
    agent: true,
  },
  { id: 'dm-bob', kind: 'dm', person: 'bob', unread: 0, time: '09:44', last: '写了，在 PR 描述里' },
  {
    id: 'dm-carol',
    kind: 'dm',
    person: 'carol',
    unread: 2,
    time: '09:15',
    last: '别忘了提交上周的周报',
  },
  {
    id: 'ag-weekly',
    kind: 'agent',
    name: '本周总结',
    unread: 0,
    time: '10:41',
    last: '我准备了一条消息，等你批准',
  },
  {
    id: 'ag-draft',
    kind: 'agent',
    name: '周报草稿',
    unread: 0,
    time: '周三',
    last: '已按你的要求改成三段',
  },
  { id: 'ag-new', kind: 'agent', name: '新的助手会话', unread: 0, time: '', last: '', fresh: true },
  {
    id: 'ag-tasks',
    kind: 'agent',
    name: '提醒与定时',
    unread: 0,
    time: '昨天',
    last: '已设置提醒：提交上周周报',
  },
  {
    id: 'ag-byok',
    kind: 'agent',
    name: '用自己的 key',
    unread: 0,
    time: '09:30',
    last: '这次请求没有完成',
    hidden: true,
  },
  {
    id: 'ch-states',
    kind: 'channel',
    name: '状态陈列',
    unread: 0,
    time: '',
    last: '',
    hidden: true,
    members: ['me', 'alice', 'bob', 'carol', 'xuqing', 'laok'],
    memberCount: 6,
    desc: '消息的各种状态，仅供设计评审',
    agent: true,
  },
]

export const conv = (id) => conversations.find((c) => c.id === id)

export function convTitle(c) {
  return c.kind === 'dm' ? people[c.person].name : c.name
}

// ---- Messages ----
// k: text | images | file | video | system | recalled | adminDeleted | pendingDelete | date | unread
//    | boundary | agent | typing
// text may use <@user:id> mentions and the Markdown subset.

const sqlSample = `-- 0007_message_seq.sql
create table messages (
  id uuid primary key default uuidv7(),
  conversation_id uuid not null references conversations(id),
  seq bigint not null,
  body text not null
);
create unique index concurrently messages_conv_seq
  on messages (conversation_id, seq);`

export const messages = {
  'ch-project': [
    { k: 'date', label: '昨天 18:05' },
    { id: 'p1', from: 'alice', t: '18:05', text: '今天把消息气泡的圆角和尾巴调好了，大家看看效果' },
    {
      id: 'p2',
      from: 'alice',
      t: '18:05',
      k: 'images',
      att: [
        { scene: 'uiLight', alt: '浅色界面截图' },
        { scene: 'uiDark', alt: '深色界面截图' },
      ],
    },
    { id: 'p3', from: 'bob', t: '18:07', text: '尾巴很自然，圆角也对得上同心规则' },
    { id: 'p4', from: ME, t: '18:10', text: '好，明天评审前把深色模式也对一遍' },
    { k: 'date', label: '今天 09:12' },
    { id: 'p5', from: 'carol', t: '09:12', text: '早。周五评审的议程我放在文档里了，大家补充一下' },
    { id: 'p6', from: 'carol', t: '09:15', text: '另外别忘了提交上周的周报' },
    {
      id: 'p7',
      from: 'bob',
      t: '09:31',
      text: `迁移脚本改好了，空库跑一遍没问题：\n\`\`\`sql\n${sqlSample}\n\`\`\``,
      wide: true,
    },
    {
      id: 'p8',
      from: 'bob',
      t: '09:32',
      text: '索引在 `messages(conversation_id, seq)`，应该够用',
    },
    { id: 'p9', from: ME, t: '09:40', reply: 'p7', text: '收到。回滚方案也写一下？' },
    {
      id: 'p10',
      from: 'bob',
      t: '09:44',
      reply: 'p9',
      text: '写了，在 PR 描述里：https://example.test/pr/128',
    },
    {
      id: 'p11',
      from: 'alice',
      t: '10:02',
      k: 'images',
      att: [
        { scene: 'board', alt: '白板' },
        { scene: 'mountains', alt: '参考图' },
        { scene: 'uiLight', alt: '浅色' },
      ],
    },
    { id: 'p12', from: 'alice', t: '10:02', text: '浅色和深色各一版，**气泡对比度**还要再测' },
    { k: 'unread' },
    {
      id: 'p13',
      from: 'xuqing',
      t: '10:05',
      text: '<@user:me> 深色的气泡对比度我测了，蓝色那组是 5.7，可以过',
      mention: true,
      edited: true,
    },
    { id: 'p14', k: 'recalled', from: 'bob', t: '10:12' },
    { id: 'p15', from: ME, t: '10:20', text: '<@user:bot> 总结一下今天的讨论', mention: false },
    {
      id: 'p16',
      from: 'bot',
      t: '10:20',
      k: 'agent',
      state: 'done',
      scope: '只读取了本频道里你们都能看到的消息',
      blocks: [
        {
          type: 'text',
          text: '今天讨论的要点：\n- **迁移**：Bob 改好了 `0007_message_seq`，空库验证通过，回滚方案在 PR 描述里。\n- **评审**：周五评审的议程在文档里，大家补充后定稿。\n- **设计**：浅色和深色各一版界面已发出，气泡对比度实测 5.7。\n- **待办**：提交上周周报；图标草案下午发出。',
        },
      ],
    },
    { id: 'p17', from: 'alice', t: '10:31', text: '总结得不错，我补一条：图标草案下午发' },
  ],

  'ch-design': [
    { k: 'boundary', when: '10月1日 14:20' },
    { k: 'date', label: '昨天 14:25' },
    { id: 'd1', from: 'xuqing', t: '14:25', text: '欢迎加入设计频道' },
    {
      id: 'd2',
      from: 'alice',
      t: '14:26',
      reply: 'hidden',
      text: '对，就按上周定的那个方案，圆角用同心规则',
    },
    { id: 'd3', from: 'laok', t: '14:31', text: '图标线宽统一用 1.75，尺寸只有 16、18、20 三档' },
    {
      k: 'system',
      text: '有新成员加入。助手现在只总结所有成员都能看到的讨论（从 10月1日 14:20 起）。',
      action: '打开我的助手面板',
    },
    { id: 'd4', from: ME, t: '14:40', text: '明白，我先看一下已有的设计令牌' },
  ],

  'dm-alice': [
    { k: 'date', label: '昨天 20:12' },
    { id: 'a1', from: 'alice', t: '20:12', text: '图标草案我画了三个方向' },
    {
      id: 'a2',
      from: 'alice',
      t: '20:12',
      k: 'images',
      att: [{ scene: 'icons', alt: '三个图标方向' }],
    },
    {
      id: 'a3',
      from: 'alice',
      t: '20:13',
      k: 'file',
      att: [{ name: '图标草案-v1.fig', size: '3.2 MiB' }],
    },
    { id: 'a4', from: ME, t: '20:20', text: '第二个最好看，能做深色版吗' },
    { id: 'a5', from: 'alice', t: '20:21', text: '可以，晚点发你' },
    { k: 'date', label: '今天 09:05' },
    { id: 'a6', from: 'alice', t: '09:05', text: '深色版做好了，你看看通透度够不够' },
    { id: 'a7', from: ME, t: '09:08', text: '收到，我中午看' },
  ],

  'dm-bob': [
    { id: 'b1', from: ME, t: '09:40', text: '收到。回滚方案也写一下？' },
    { id: 'b2', from: 'bob', t: '09:44', text: '写了，在 PR 描述里' },
  ],
  'dm-carol': [
    { id: 'c1', from: 'carol', t: '09:14', text: '早' },
    { id: 'c2', from: 'carol', t: '09:15', text: '别忘了提交上周的周报' },
  ],

  'g-hike': [
    { k: 'system', text: '**Carol Wu** 加入了群组' },
    { k: 'system', text: '**Alice Chen** 将群名改为「周末徒步」' },
    { k: 'date', label: '今天 09:50' },
    { id: 'h1', from: 'carol', t: '09:48', text: '周六天气不错，8:30 地铁口集合？' },
    { id: 'h2', from: 'laok', t: '09:49', text: '可以，我带水' },
    { id: 'h3', from: 'carol', t: '09:50', text: '周六 8:30 地铁口见' },
    { k: 'unread' },
    { id: 'h4', from: 'xuqing', t: '09:52', text: '我可能会晚到十分钟，不用等我' },
  ],

  'g-fam': [{ id: 'f1', from: 'dana', t: '周二', text: '周末回家吃饭' }],
  'ch-random': [
    { id: 'r1', from: 'laok', t: '10:18', text: '中午吃什么' },
    { id: 'r2', from: 'xuqing', t: '10:19', text: '楼下新开了一家面馆' },
  ],
  'ch-announce': [{ id: 'n1', from: 'carol', t: '周三', text: '10 月邀请名额已更新，每人 5 个' }],
}

// Agent sessions. Blocks are drawn by agent.js (tool cards, approval card, tasks, memory chips).
const SUMMARY_TEXT =
  '今天 #项目组 的要点：\n- **迁移**：Bob 改好了 `0007_message_seq`，空库验证通过，回滚方案在 PR 描述里。\n- **评审**：周五评审议程在文档里，等大家补充。\n- **设计**：深色气泡对比度实测 5.7，通过。'

messages['ag-weekly'] = [
  { k: 'date', label: '今天 10:38' },
  { id: 'w1', from: ME, t: '10:38', text: '总结一下今天 #项目组 的讨论' },
  {
    id: 'w2',
    from: 'bot',
    t: '10:38',
    k: 'agent',
    state: 'done',
    blocks: [
      {
        type: 'tool',
        state: 'done',
        running: '正在读取未读消息…',
        done: '读取了 #项目组 的 17 条消息',
        params: { conversation: '#项目组', range: '今天 09:12 起', limit: 300 },
        hits: [
          'Bob Lin：迁移脚本改好了，空库跑一遍没问题',
          'Carol Wu：周五评审的议程我放在文档里了',
          '许晴：深色的气泡对比度我测了，蓝色那组是 5.7',
        ],
        took: '1.4 秒',
      },
      { type: 'text', text: SUMMARY_TEXT },
      { type: 'sources', items: ['Bob Lin 09:31', 'Carol Wu 09:12', '许晴 10:05'] },
    ],
  },
  { id: 'w3', from: ME, t: '10:40', text: '在 #项目组 说一声：周五评审改到 15:00，议程见文档' },
  {
    id: 'w4',
    from: 'bot',
    t: '10:41',
    k: 'agent',
    state: 'waiting',
    blocks: [
      {
        type: 'text',
        text: '好的，我准备了一条消息。因为会发给 #项目组 的其他人，需要你批准后才会发送。',
      },
      {
        type: 'approval',
        approval: {
          id: 'apr-1',
          state: 'pending',
          target: '项目组',
          audience: '128 位成员',
          body: '周五评审改到 **15:00**，议程见文档，请大家提前补充。',
          left: '23 小时 41 分',
        },
      },
    ],
  },
]

messages['ag-draft'] = [
  { k: 'date', label: '周三 17:20' },
  {
    id: 'dr1',
    from: ME,
    t: '17:20',
    text: '帮我把本周周报改成三段：进展、问题、下周计划。记住我的周报都用这个格式',
  },
  {
    id: 'dr2',
    from: 'bot',
    t: '17:21',
    k: 'agent',
    state: 'done',
    canRegenerate: true,
    blocks: [
      {
        type: 'text',
        text: '这是改好的周报：\n\n**进展**：完成消息气泡与深色模式的第一轮对比度检查；迁移脚本空库验证通过。\n\n**问题**：玻璃层在清透档下的文字对比度需要实测。\n\n**下周计划**：评审定稿，开始前端骨架。',
      },
      { type: 'memory', text: '周报用「进展、问题、下周计划」三段式' },
    ],
  },
]

messages['ag-new'] = []

messages['ag-tasks'] = [
  { k: 'date', label: '昨天 18:12' },
  { id: 'tk1', from: ME, t: '18:12', text: '明天上午 9 点提醒我交周报' },
  {
    id: 'tk2',
    from: 'bot',
    t: '18:12',
    k: 'agent',
    state: 'done',
    blocks: [
      { type: 'text', text: '好的，已经为你设置好提醒：' },
      {
        type: 'task',
        task: {
          kind: 'reminder',
          title: '提交上周周报',
          date: '2026年10月3日 周六 09:00',
          tz: 'Asia/Shanghai',
          offset: 'UTC+08:00',
          device: 'Windows · Edge 154（此设备）',
          state: 'active',
        },
      },
    ],
  },
  { id: 'tk3', from: ME, t: '18:15', text: '周五 18:00 在 #闲聊 发一条：周末愉快' },
  {
    id: 'tk4',
    from: 'bot',
    t: '18:15',
    k: 'agent',
    state: 'done',
    blocks: [
      {
        type: 'text',
        text: '你已经批准了这条定时消息，到点会以你的名义发送，并标注「经助手代发」：',
      },
      {
        type: 'task',
        task: {
          kind: 'schedule',
          title: '周末愉快',
          date: '2026年10月9日 周五 18:00',
          tz: 'Asia/Shanghai',
          offset: 'UTC+08:00',
          device: 'Windows · Edge 154（此设备）',
          where: '# 闲聊',
          state: 'active',
        },
      },
    ],
  },
  { id: 'tk5', from: ME, t: '18:20', text: '按纽约时间 2026年11月1日 1:30 提醒我换备份盘' },
  {
    id: 'tk6',
    from: 'bot',
    t: '18:20',
    k: 'agent',
    state: 'done',
    blocks: [
      { type: 'text', text: '这个时间在纽约的夏令时结束那天，需要你确认是哪一次：' },
      { type: 'dst', variant: 'ambiguous' },
    ],
  },
  { id: 'tk7', from: ME, t: '18:22', text: '按纽约时间 2027年3月14日 2:30 提醒我' },
  {
    id: 'tk8',
    from: 'bot',
    t: '18:22',
    k: 'agent',
    state: 'done',
    blocks: [
      { type: 'text', text: '这个时间不存在，需要你另选一个：' },
      { type: 'dst', variant: 'missing' },
    ],
  },
]

messages['ag-byok'] = [
  { k: 'date', label: '今天 09:30' },
  { id: 'by1', from: ME, t: '09:30', text: '总结一下今天的讨论' },
  {
    id: 'by2',
    from: 'bot',
    t: '09:30',
    k: 'agent',
    state: 'done',
    blocks: [
      {
        type: 'error',
        title: '这次请求没有完成',
        text: '你的 API key 余额不足。检查余额后可以继续用它，也可以改用站点额度。',
        action: '使用站点额度发起新请求',
      },
    ],
  },
]

messages['ch-states'] = [
  { k: 'date', label: '今天 10:40' },
  { id: 'x1', from: 'alice', t: '10:40', text: '这个频道把消息的各种状态放在一起，方便评审' },
  {
    id: 'x2',
    from: ME,
    t: '10:41',
    text: '这条正在发送，会显示为淡色并带「发送中」',
    state: 'sending',
  },
  {
    id: 'x3',
    from: ME,
    t: '10:41',
    text: '这条发送失败了，点红色感叹号可以重试或删除',
    state: 'failed',
  },
  { id: 'x4', from: ME, t: '10:42', text: '这条改过了', edited: true },
  { id: 'x5', k: 'recalled', from: 'bob', t: '10:42' },
  { k: 'adminDeleted' },
  { k: 'pendingDelete' },
  {
    id: 'x6',
    from: 'carol',
    t: '10:43',
    reply: 'x1',
    text: '回复一条消息：点引用条会跳到原消息，原消息高亮 1 秒',
  },
  {
    id: 'x7',
    from: 'carol',
    t: '10:43',
    reply: 'hidden',
    text: '回复了加入之前的消息：引用条显示「原消息不可见」',
  },
  {
    id: 'x8',
    from: 'xuqing',
    t: '10:44',
    text: '<@user:me> 这条提到了你，整条消息带淡淡的强调色背景',
    mention: true,
  },
  {
    id: 'x9',
    from: 'laok',
    t: '10:44',
    text: '链接会自动识别，遇到中文和全角标点就结束：https://example.test/spec/02，后面是中文。',
  },
  {
    id: 'x10',
    from: 'bob',
    t: '10:45',
    text: '```ts\nexport async function authorize(userId: string, conversationId: string) {\n  // 所有读写都先过这里\n  const member = await findMember(conversationId, userId)\n  if (!member) throw new NotFound()\n  return member\n}\n```',
    wide: true,
  },
  { id: 'x11', from: 'alice', t: '10:46', k: 'video', att: [{ scene: 'mountains', alt: '视频' }] },
  {
    id: 'x12',
    from: 'alice',
    t: '10:46',
    k: 'file',
    att: [{ name: '评审议程.pdf', size: '412 KiB' }],
  },
  {
    id: 'x13',
    from: 'xuqing',
    t: '10:47',
    text: `一条很长的消息：${'这是为了看换行和最大宽度（时间线的 65%）。'.repeat(6)}`,
  },
]

export const quickActions = [
  { id: 'unread', icon: 'list-checks', label: '总结未读', prompt: '总结这个会话的未读消息' },
  { id: 'range', icon: 'text-quote', label: '总结这段讨论', prompt: '总结最近这段讨论' },
  { id: 'find', icon: 'search', label: '找消息', prompt: '帮我找一下关于迁移脚本的消息' },
  { id: 'draft', icon: 'pencil', label: '起草回复', prompt: '帮我起草一条回复' },
  { id: 'translate', icon: 'languages', label: '翻译选中内容', prompt: '把选中的内容翻译成英文' },
]

export const notifications = [
  {
    id: 'n-mention',
    kind: 'mention',
    icon: 'at-sign',
    title: '许晴 在 #项目组 提到了你',
    body: '深色的气泡对比度我测了，蓝色那组是 5.7',
    time: '10:05',
    unread: true,
    to: 'ch-project',
  },
  {
    id: 'n-approval',
    kind: 'approval',
    icon: 'shield-check',
    title: '助手在等你批准',
    body: '发送消息到 #项目组',
    time: '10:41',
    unread: true,
    to: 'ag-weekly',
  },
  {
    id: 'n-reminder',
    kind: 'reminder',
    icon: 'alarm-clock',
    title: '提醒：提交上周周报',
    body: '你在 昨天 18:12 让助手设置的提醒',
    time: '09:00',
    unread: false,
    to: 'ag-weekly',
  },
  {
    id: 'n-invite',
    kind: 'invite',
    icon: 'user-plus',
    title: 'Dana Wei 用你的邀请码完成了注册',
    body: '她还没有验证邮箱，7 天内未验证会自动清理',
    time: '昨天',
    unread: false,
    to: null,
  },
]

export const devices = [
  {
    id: 'dev-1',
    name: 'Windows · Edge 154',
    current: true,
    active: '现在',
    ip: '203.0.113.24',
    created: '10月1日',
    tasks: 0,
  },
  {
    id: 'dev-2',
    name: 'macOS · Safari 26',
    current: false,
    active: '昨天 22:10',
    ip: '198.51.100.7',
    created: '9月29日',
    tasks: 1,
  },
  {
    id: 'dev-3',
    name: 'iPhone · Safari',
    current: false,
    active: '9月28日',
    ip: '192.0.2.88',
    created: '9月28日',
    tasks: 0,
  },
]

export const memories = [
  { id: 'm1', text: '每周五要提交周报', source: '你在 9月26日 明确要求记住', site: false },
  { id: 'm2', text: '偏好简洁的中文回答', source: '你在设置里手动添加', site: true },
]

export const invites = {
  slots: { used: 2, total: 5 },
  codes: [
    { id: 'i1', tail: '7f3a', state: '未使用', expires: '6 天后过期', uses: '1 次' },
    { id: 'i2', tail: 'c20d', state: '已使用 1/1', expires: '', uses: '1 次' },
  ],
  pending: [{ id: 'pr1', username: 'dana_w', note: '7 天内未验证邮箱会自动清理' }],
}

export const emojis = [
  '😀',
  '😄',
  '😊',
  '🙂',
  '😉',
  '😍',
  '🤔',
  '😅',
  '😂',
  '🥹',
  '😭',
  '😎',
  '🙏',
  '👍',
  '👏',
  '🎉',
  '🔥',
  '✨',
  '❤️',
  '💡',
  '✅',
  '❌',
  '👀',
  '🚀',
  '☕',
  '🍜',
  '🌧️',
  '⭐',
  '📌',
  '📎',
  '🧩',
  '🛠️',
]

export const commands = [
  { id: 'cmd-summary', icon: 'list-checks', label: '/总结', hint: '总结当前会话', needsAI: true },
  { id: 'cmd-translate', icon: 'languages', label: '/翻译', hint: '翻译选中内容', needsAI: true },
  {
    id: 'cmd-remind',
    icon: 'alarm-clock',
    label: '/提醒我 …',
    hint: '设置一条提醒',
    needsAI: true,
  },
]

export const shortcuts = [
  { keys: ['⌘', 'K'], label: '命令面板：跳转、搜索、命令' },
  { keys: ['⌘', 'J'], label: '打开或关闭助手面板' },
  { keys: ['⌥', '↑ / ↓'], label: '上一个或下一个会话' },
  { keys: ['⌥', '⇧', '↑ / ↓'], label: '上一个或下一个未读会话' },
  { keys: ['↑'], label: '输入框为空时，编辑上一条消息' },
  { keys: ['Enter'], label: '发送，Shift+Enter 换行' },
  { keys: ['Esc'], label: '关闭弹层，取消编辑或回复' },
  { keys: ['⌘', '/'], label: '快捷键帮助' },
]

// ---- Reset: scenes start from the same data every time ----

const PRISTINE = {
  messages: structuredClone(messages),
  conversations: structuredClone(conversations),
  notifications: structuredClone(notifications),
}

export function resetData() {
  for (const key of Object.keys(messages)) delete messages[key]
  Object.assign(messages, structuredClone(PRISTINE.messages))
  conversations.splice(0, conversations.length, ...structuredClone(PRISTINE.conversations))
  notifications.splice(0, notifications.length, ...structuredClone(PRISTINE.notifications))
}
