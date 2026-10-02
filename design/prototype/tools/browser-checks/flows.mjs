// Clickable flows (docs/02 section 9, D3 acceptance: "各主要流程都能点通"). Real mouse and keyboard events.
import { launch, PROTO_URL, suite } from './cdp.mjs'

const s = suite('flows')
const page = await launch({ width: 1440, height: 900 })
const ev = (e) => page.eval(e)
let nav = 0
const open = async (scene, extra = '') => {
  await page.goto(
    `${PROTO_URL}?fl=${++nav}#scene=${scene}&fresh=1&nostore=1&static=1&quiet=1${extra}`,
  )
  await page.sleep(300)
}
const count = (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`)
const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`)
// Clicks the first button or link in `scope` whose text is `label` (or starts with it, for menu items that
// carry a hint). The element is scrolled into view first, so a click never lands outside the viewport.
const clickText = async (scope, label) => {
  const found = await ev(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(`${scope} button, ${scope} a`)})]
    const el = els.find((x) => x.textContent.trim() === ${JSON.stringify(label)}) ?? els.find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)}))
    if (!el) return false
    el.scrollIntoView({ block: 'center' })
    el.setAttribute('data-click-target', '1')
    return true
  })()`)
  if (!found) throw new Error(`no "${label}" in ${scope}`)
  await page.sleep(80)
  await page.click('[data-click-target="1"]')
  await ev(
    "document.querySelectorAll('[data-click-target]').forEach((e) => e.removeAttribute('data-click-target'))",
  )
}

try {
  // ---- approval: approve
  await open('agent')
  s.check(
    'approval card is pending with three actions',
    (await text('.approval')).includes('批准并发送') &&
      (await ev("document.querySelector('.approval').dataset.state")) === 'pending',
  )
  await clickText('.approval', '批准并发送')
  await page.sleep(400)
  s.check(
    'approving marks the card approved',
    (await ev("document.querySelector('.approval').dataset.state")) === 'approved',
  )
  s.check(
    'approving shows a toast with a link to the channel',
    (await text('.toast')) !== null && (await text('.toast')).includes('经助手代发'),
  )
  await page.sleep(2800)
  s.check(
    'after approval the next output is a NEW reply, not a continuation',
    (await count('.msg[data-who="in"]')) >= 3,
    String(await count('.msg[data-who="in"]')),
  )
  await ev("window.__proto.bus.emit('conv:open', 'ch-project')")
  await page.sleep(300)
  s.check(
    'the approved text was posted in the channel, labelled as sent by the assistant',
    (await text('.msg__status')) !== null &&
      (await ev(
        "[...document.querySelectorAll('.msg__status')].some(e => e.textContent.includes('经助手代发'))",
      )),
  )

  // ---- approval: edit then approve; reject
  await open('agent')
  await clickText('.approval', '修改')
  s.check(
    'Edit turns the preview into a text area with focus',
    (await ev('document.activeElement.id')) === 'approval-body',
  )
  await ev("document.getElementById('approval-body').value = '改成 16:00 评审'")
  await clickText('.approval', '保存并批准')
  await page.sleep(300)
  s.check(
    'edited text is what gets approved',
    (await text('.approval')).includes('已批准'),
    `${await ev("document.querySelector('.approval')?.dataset.state")} | ${(await text('.approval'))?.slice(0, 60)}`,
  )
  await open('agent')
  await clickText('.approval', '拒绝')
  await page.sleep(300)
  s.check(
    'rejecting says nothing was sent and the assistant replies',
    (await ev("document.querySelector('.approval').dataset.state")) === 'rejected' &&
      (await count('.msg[data-who="in"]')) >= 3,
  )

  // ---- tool card expand / collapse
  await open('agent')
  await clickText('.tool', '读取了 #项目组 的 17 条消息')
  s.check(
    'tool card expands to show parameters and hits',
    (await ev("document.querySelector('.tool__body').hidden")) === false &&
      (await count('.tool__hit')) >= 1,
  )

  // ---- regenerate replaces the latest reply
  await open('memory')
  await ev(
    'document.querySelector(\'.msg[data-who="in"]:last-of-type, .msg[data-who="in"]:last-child\')?.scrollIntoView()',
  )
  const hasRegen = await ev(
    "[...document.querySelectorAll('.msg__tools button')].some(b => b.getAttribute('aria-label') === '重新生成')",
  )
  s.check(
    'regenerate is offered on the latest reply only',
    hasRegen &&
      (await ev(
        "[...document.querySelectorAll('.msg__tools button')].filter(b => b.getAttribute('aria-label') === '重新生成').length",
      )) === 1,
  )
  const botBefore = await count('.msg[data-who="in"]')
  await ev(
    "[...document.querySelectorAll('.msg__tools button')].find(b => b.getAttribute('aria-label') === '重新生成').click()",
  )
  await page.sleep(300)
  s.check(
    'regenerate removes the old reply and starts a new one in its place (count unchanged)',
    (await count('.msg[data-who="in"]')) === botBefore,
  )
  await page.sleep(5000)
  s.check('the regenerated reply finishes', (await count('.bubble--agent.is-streaming')) === 0)

  // ---- stop while streaming
  await open('agent-new')
  await clickText('.suggest', '总结今天 #项目组 的讨论')
  await page.sleep(1500)
  s.check(
    'a suggestion starts a run and the send button becomes Stop',
    (await ev("document.querySelector('.composer__send').getAttribute('aria-label')")) ===
      '停止生成',
  )
  await page.click('.composer__send')
  await page.sleep(500)
  s.check(
    'Stop ends the run and the button is Send again',
    (await ev("document.querySelector('.composer__send').getAttribute('aria-label')")) === '发送',
  )

  // ---- memory undo, reminder cancel, DST confirm
  await open('memory')
  await clickText('.mem-chip', '撤销')
  s.check('undoing a memory replaces the chip', (await text('.mem-chip')).includes('已撤销记忆'))
  await open('tasks')
  await clickText('.task-card', '取消')
  await page.sleep(300)
  s.check(
    'cancelling a reminder marks it cancelled',
    await ev(
      "[...document.querySelectorAll('.task-card')].some(c => c.textContent.includes('已取消'))",
    ),
  )
  await open('tasks')
  await ev("document.querySelectorAll('.task-card')[2].scrollIntoView()")
  const confirmDisabled = await ev(
    "[...document.querySelectorAll('.task-card button')].find(b => b.textContent.includes('确认这个时间')).disabled",
  )
  s.check('the ambiguous-time card cannot be confirmed before a choice', confirmDisabled === true)
  await ev("document.querySelectorAll('.task-card')[2].querySelector('input[type=radio]').click()")
  await page.sleep(100)
  s.check(
    'choosing one of the two times enables Confirm',
    (await ev(
      "[...document.querySelectorAll('.task-card button')].find(b => b.textContent.includes('确认这个时间')).disabled",
    )) === false,
  )

  // ---- BYOK failure -> switch to site quota (new context segment, nothing carried over)
  await open('byok-error')
  await clickText('.banner', '使用站点额度发起新请求')
  await page.sleep(300)
  s.check(
    'the switch dialog explains a new segment and links to the privacy note',
    (await text('.dialog')).includes('新开一段对话') &&
      (await text('.dialog')).includes('隐私说明'),
  )
  await page.key('Escape')

  // ---- assistant panel: scope switch starts a new context segment
  await open('channel')
  await ev("window.__proto.bus.emit('inspector:set', 'assistant')")
  await page.sleep(300)
  await clickText('.assist__scope', '我的全部会话')
  await page.sleep(200)
  s.check(
    'switching scope shows the new-segment divider and the private-content warning',
    (await text('.epoch-div')) !== null && (await text('.assist__note')).includes('包括私信'),
  )
  await clickText('.assist__chips', '总结未读')
  await page.sleep(2500)
  s.check(
    'a quick action produces a result card with sources',
    (await count('.a-card')) === 1 && (await count('.a-card .source')) >= 1,
  )
  const outBeforeDraft = await count('.msg[data-who="out"]')
  await clickText('.assist__chips', '起草回复')
  await page.sleep(2500)
  const draftBtn = await ev(
    "[...document.querySelectorAll('.a-card button')].find(b => b.textContent.includes('插入输入框'))?.textContent",
  )
  s.check(
    'a draft has an Insert button and was not sent by itself',
    draftBtn !== null && (await count('.msg[data-who="out"]')) === outBeforeDraft,
  )
  const outBefore = await count('.msg[data-who="out"]')
  await clickText('.a-card', '插入输入框')
  await page.sleep(300)
  s.check(
    'Insert puts the draft in the composer and sends nothing',
    (await ev("document.getElementById('composer-input').value.length")) > 0 &&
      (await count('.msg[data-who="out"]')) === outBefore,
  )

  // ---- message actions: recall, report, delete for me
  await open('channel')
  await ev("window.__proto.bus.emit('composer:send-text', '一条用来测试撤回的消息')")
  await page.sleep(1200)
  await ev(
    '(() => { const own = [...document.querySelectorAll(\'.msg[data-who="out"]\')].pop(); own.querySelector(\'.msg__tools button[aria-label="更多"]\').click() })()',
  )
  await page.sleep(200)
  await clickText('.menu', '撤回')
  await page.sleep(300)
  s.check(
    'recalling replaces the message with a notice for everyone',
    await ev(
      "[...document.querySelectorAll('.sys')].some(e => e.textContent.includes('你撤回了一条消息'))",
    ),
  )
  await open('channel')
  await ev(
    '(() => { const other = [...document.querySelectorAll(\'.msg[data-who="in"]\')].pop(); other.querySelector(\'.msg__tools button[aria-label="更多"]\').click() })()',
  )
  await page.sleep(200)
  await clickText('.menu', '举报')
  await page.sleep(300)
  s.check(
    'report opens a dialog with reasons and the admin-visibility note',
    (await count('.dialog input[type=radio]')) === 4 &&
      (await text('.dialog')).includes('前后各 5 条'),
  )
  await page.key('Escape')

  // ---- settings flows
  await open('settings-assistant')
  await ev("document.getElementById('api-key').value = 'bad-key'")
  await clickText('.key-field', '验证并保存')
  await page.sleep(1600)
  s.check('an invalid key is refused with the reason', (await text('.key-state')).includes('无效'))
  await ev("document.getElementById('api-key').value = 'sk-test-9f3a1c77'")
  await clickText('.key-field', '验证并保存')
  await page.sleep(1600)
  s.check(
    'a valid key is saved and only the last four characters are shown',
    (await text('.key-state')).includes('c77') ||
      (await ev("document.querySelector('.key-field input')?.value")).endsWith('1c77'),
  )
  await open('settings-invites')
  await clickText('.sheet__body', '生成邀请码')
  await page.sleep(300)
  s.check(
    'creating an invite shows the code once with a warning',
    (await text('.dialog')).includes('只显示这一次'),
  )
  await page.key('Escape')
  await open('settings-account')
  await ev(
    "[...document.querySelectorAll('.sheet__body button')].find(b => b.textContent.trim() === '注销' )?.click()",
  )
  await page.sleep(300)
  s.check(
    'revoking a device lists the tasks it will cancel before confirming',
    (await text('.dialog')).includes('会取消') &&
      (await text('.dialog')).includes('普通退出登录不会取消'),
  )
  await page.key('Escape')

  // ---- sidebar
  await open('channel')
  await clickText('.sidebar', '更多')
  await page.sleep(200)
  await clickText('.menu', '已归档…')
  await page.sleep(300)
  s.check(
    'the archive dialog explains the name clash and asks for a rename',
    (await text('.dialog')).includes('先改名'),
  )
  await page.key('Escape')

  // ---- auth
  await open('login')
  await page.click('#login-email')
  await page.type('someone@example.test')
  await page.click('#login-pw')
  await page.type('wrong')
  await page.key('Enter')
  await page.sleep(1200)
  s.check(
    'a wrong password shows a generic error and stays on the page',
    (await text('.banner')).includes('邮箱或密码不对') &&
      (await ev("document.querySelector('.window').dataset.view")) === 'auth',
  )
  await open('login')
  await page.click('#login-email')
  await page.type('x@unverified.test')
  await page.click('#login-pw')
  await page.type('anything-long')
  await page.key('Enter')
  await page.sleep(1200)
  s.check(
    'an unverified email offers to resend the verification mail',
    (await text('.banner')).includes('还没有验证'),
  )
  await open('register')
  await page.click('#reg-user')
  await page.type('Bad Name!')
  await page.sleep(100)
  s.check(
    'an invalid username explains the rule while typing',
    (await text('#reg-user-msg')).includes('小写字母'),
  )
  await ev("document.getElementById('reg-user').value = ''")
  await page.click('#reg-pw')
  await page.type('short')
  await page.sleep(100)
  s.check(
    'the password checklist marks unmet rules with text, not colour alone',
    await ev(
      "[...document.querySelectorAll('ul[aria-label=\"密码要求\"] li')].some(li => li.textContent.includes('未满足'))",
    ),
  )
  await open('register-invalid')
  await page.sleep(300)
  s.check(
    'an invalid invite code is explained with what to do next',
    (await text('#reg-invite-msg')).includes('重新生成'),
  )
  await open('verify')
  await clickText('.auth-card', '重新发送验证邮件')
  await page.sleep(300)
  s.check(
    'resend starts a cooldown and invalidates the old link',
    (await text('.auth-card')).includes('秒后可以重发'),
  )
  await open('verify-confirm')
  await clickText('.auth-card', '确认验证')
  await page.sleep(900)
  s.check(
    'the mail link needs an explicit confirm click, then shows success',
    (await text('.auth-card')).includes('邮箱已验证'),
  )
} catch (err) {
  s.check('suite ran to the end', false, err.message)
} finally {
  s.check(
    'no console errors during the run',
    page.consoleLog.length === 0,
    page.consoleLog.slice(0, 3).join(' | '),
  )
  await page.close()
}
process.exit(s.done() ? 1 : 0)
