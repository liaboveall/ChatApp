/**
 * Source of the UI texts. `bun apps/web/tools/generate-messages.ts` writes `messages/zh-CN.json` and `messages/en.json`
 * from it, so both languages always have exactly the same keys. Parameters are written {name}. A value that is an
 * object `{ zh, en }` is plain text; `plural` gives English one/other forms for a count (Chinese has no plural).
 */

export type Entry =
  | { zh: string; en: string }
  | { zh: string; plural: { one: string; other: string }; param: string }

const t = (zh: string, en: string): Entry => ({ zh, en })
const plural = (param: string, zh: string, one: string, other: string): Entry => ({
  zh,
  param,
  plural: { one, other },
})

export const MESSAGES: Record<string, Entry> = {
  // ── common ──
  common_cancel: t('取消', 'Cancel'),
  common_close: t('关闭', 'Close'),
  common_copied: t('已复制', 'Copied'),
  common_copy: t('复制', 'Copy'),
  common_copy_failed: t(
    '复制失败，请手动选中文字复制。',
    'Could not copy. Select the text and copy it by hand.',
  ),
  common_done: t('完成', 'Done'),
  common_loading: t('正在加载…', 'Loading…'),
  common_or: t('或', 'or'),
  common_retry: t('重试', 'Try again'),
  common_save: t('保存', 'Save'),

  // ── errors ──
  error_conflict: t(
    '数据刚刚在别处被修改了，请刷新后再试。',
    'The data was just changed somewhere else. Reload and try again.',
  ),
  error_forbidden: t('你没有权限这样做。', 'You are not allowed to do that.'),
  error_internal: t(
    '服务出了点问题，请稍后再试。',
    'Something went wrong on our side. Please try again later.',
  ),
  error_internal_with_id: t(
    '服务出了点问题，请稍后再试。（请求编号 {requestId}）',
    'Something went wrong on our side. Please try again later. (Request {requestId})',
  ),
  error_network: t(
    '连不上服务器。请检查网络后重试。',
    "Can't reach the server. Check your connection and try again.",
  ),
  error_not_found: t(
    '找不到这个内容，它可能已被删除。',
    'That could not be found. It may have been deleted.',
  ),
  error_quota: t('已达到上限，暂时不能继续。', "You've reached the limit for now."),
  error_rate_limited: t(
    '操作太频繁了，请稍后再试。',
    'Too many attempts. Please wait a moment and try again.',
  ),
  error_rate_limited_seconds: t(
    '操作太频繁了，请 {seconds} 秒后再试。',
    'Too many attempts. Try again in {seconds} s.',
  ),
  error_timeout: t('请求超时了，请重试。', 'The request timed out. Please try again.'),
  error_too_large: t('内容太大，无法提交。', 'That is too large to send.'),
  error_unauthenticated: t(
    '登录已失效，请重新登录。',
    "You've been signed out. Please sign in again.",
  ),
  error_unavailable: t(
    '服务暂时不可用，请稍后再试。',
    'The service is temporarily unavailable. Please try again later.',
  ),
  error_unknown: t('出错了，请重试。', 'Something went wrong. Please try again.'),
  error_validation: t(
    '有些内容没有通过检查，请对照提示修改。',
    "Some entries didn't pass the checks. Please review the messages.",
  ),

  // ── fields ──
  field_email: t('邮箱', 'Email'),
  field_error_email: t('请输入完整的邮箱地址。', 'Enter a complete email address.'),
  field_error_password_required: t('请输入密码。', 'Enter your password.'),
  field_password: t('密码', 'Password'),
  field_password_hide: t('隐藏密码', 'Hide password'),
  field_password_show: t('显示密码', 'Show password'),

  // ── login ──
  login_page_title: t('登录', 'Sign in'),
  login_title: t('登录 {product}', 'Sign in to {product}'),
  login_lead: t(
    '邀请制的实时聊天社区。没有账号？需要有人给你一个邀请码。',
    'An invitation-only real-time chat community. No account yet? You need an invitation code from someone.',
  ),
  login_submit: t('登录', 'Sign in'),
  login_forgot: t('忘记密码？', 'Forgot your password?'),
  login_passkey: t('使用 Passkey 登录', 'Sign in with a passkey'),
  login_have_invite: t('有邀请码？', 'Have an invitation code?'),
  login_register_link: t('注册账号', 'Create an account'),
  login_error_credentials: t(
    '邮箱或密码不对。连续输错会被暂时限制，请稍后再试。',
    'The email or password is wrong. Repeated failures are limited for a while.',
  ),
  login_error_unverified: t(
    '这个邮箱还没有验证，不能登录。',
    "This email address hasn't been verified yet, so you can't sign in.",
  ),
  login_error_inactive: t('这个账号目前不能登录。', "This account can't sign in right now."),
  login_resend_verification: t('重新发送验证邮件', 'Send the verification email again'),
  login_reason_expired: t(
    '登录已失效（可能是在其他设备上被注销，或修改了密码），请重新登录。',
    'Your sign-in has ended (you may have been signed out from another device, or your password changed). Please sign in again.',
  ),
  login_reason_password_changed: t(
    '密码已修改，请用新密码重新登录。',
    'Your password was changed. Sign in again with the new one.',
  ),
  login_reason_signed_out: t('你已退出登录。', 'You have signed out.'),
  passkey_failed: t(
    'Passkey 没有验证成功，请重试或改用密码。',
    "The passkey didn't work. Try again or use your password.",
  ),
  passkey_unsupported: t(
    '这个浏览器或设备不支持 Passkey，请使用密码登录。',
    "This browser or device doesn't support passkeys. Use your password instead.",
  ),

  // ── register ──
  register_page_title: t('注册', 'Create account'),
  register_title: t('注册 {product}', 'Join {product}'),
  register_lead: t(
    '需要一个邀请码。注册后要验证邮箱，才能登录。',
    'You need an invitation code. After signing up you verify your email before you can sign in.',
  ),
  register_invite_label: t('邀请码', 'Invitation code'),
  register_invite_hint: t(
    '来自注册链接里 # 后面的部分，不会发到服务器。也可以手动输入。',
    'It comes from the part of the registration link after #, which is never sent to the server. You can also type it.',
  ),
  register_invite_ok: t('邀请码有效。', 'The invitation code is valid.'),
  register_invite_invalid: t(
    '邀请码无效、已过期或已用完。请向邀请你的人确认，或让对方重新生成一个。',
    'This invitation code is invalid, expired or used up. Ask the person who invited you for a new one.',
  ),
  register_invite_malformed: t(
    '邀请码格式不对，应为 16 位字母和数字（如 ABCD-EFGH-IJKL-MNOP）。',
    "That isn't a valid code format. It should be 16 letters and digits (like ABCD-EFGH-IJKL-MNOP).",
  ),
  register_username_label: t('用户名', 'Username'),
  register_username_hint: t(
    '3–20 位小写字母、数字、下划线，用于 @提及。',
    '3–20 lowercase letters, digits or underscores. Used for @mentions.',
  ),
  register_username_rule: t(
    '用户名要 3–20 位，只能用小写字母、数字和下划线。',
    'The username must be 3–20 characters: lowercase letters, digits and underscores only.',
  ),
  register_username_reserved: t(
    '这个用户名被保留了，换一个。',
    'That username is reserved. Choose another.',
  ),
  register_username_taken: t(
    '这个用户名已被占用，换一个。',
    'That username is taken. Choose another.',
  ),
  register_name_label: t('显示名', 'Display name'),
  register_name_hint: t(
    '1–32 个字符，可以重复，支持中文和 emoji。',
    '1–32 characters. It does not have to be unique; any language and emoji work.',
  ),
  register_name_required: t('请填写显示名。', 'Enter a display name.'),
  register_name_rule: t(
    '显示名最多 32 个字符，不能含控制字符。',
    'At most 32 characters, with no control characters.',
  ),
  register_name_reserved: t(
    '这个显示名被保留了，换一个。',
    'That display name is reserved. Choose another.',
  ),
  register_password_unmet: t(
    '密码还没有满足下面的要求。',
    "The password doesn't meet the requirements below yet.",
  ),
  register_submit: t('注册', 'Create account'),
  register_have_account: t('已有账号？', 'Already have an account?'),
  register_login_link: t('登录', 'Sign in'),

  // ── password rules ──
  password_rules_label: t('密码要求', 'Password requirements'),
  password_rule_length: t('至少 {min} 位', 'At least {min} characters'),
  password_rule_simple: t('不是重复或连续的字符', 'Not a repeated or sequential pattern'),
  password_rule_identity: t(
    '不含邮箱前缀、用户名、显示名或产品名',
    "Doesn't contain your email name, username, display name or the product name",
  ),
  password_rule_common: t(
    '不是常见弱密码（提交时检查）',
    'Not a commonly used password (checked when you submit)',
  ),
  password_rule_idle: t('，尚未检查', ', not checked yet'),
  password_rule_pass: t('，已满足', ', met'),
  password_rule_fail: t('，未满足', ', not met'),
  password_problem_too_short: t('密码至少 10 位。', 'The password needs at least 10 characters.'),
  password_problem_too_long: t('密码最多 128 位。', 'The password can be at most 128 characters.'),
  password_problem_too_common: t(
    '这是常见的弱密码，换一个。',
    "That's a commonly used password. Choose another.",
  ),
  password_problem_too_simple: t(
    '密码太简单（字符重复或连续），换一个。',
    'That password is too simple (repeated or sequential). Choose another.',
  ),
  password_problem_contains_identity: t(
    '密码里不能包含邮箱前缀、用户名、显示名或产品名。',
    "The password can't contain your email name, username, display name or the product name.",
  ),
  password_problem_generic: t(
    '这个密码不能用，换一个。',
    "That password can't be used. Choose another.",
  ),

  // ── verify email ──
  verify_page_title: t('验证邮箱', 'Verify email'),
  verify_sent_title: t('查看你的邮箱', 'Check your inbox'),
  verify_sent_text: t(
    '我们向 {email} 发送了验证邮件。链接 1 小时内有效，只能使用一次，验证后才能登录。',
    'We sent a verification email to {email}. The link works for one hour and only once. You can sign in after verifying.',
  ),
  verify_resend: t('重新发送验证邮件', 'Send the email again'),
  verify_resend_wait: t('{seconds} 秒后可以重发', 'You can resend in {seconds} s'),
  verify_sent_note: t(
    '重发后，旧的链接会失效。7 天内没有验证，账号会被自动删除。',
    'Sending again invalidates the old link. Accounts not verified within 7 days are deleted.',
  ),
  verify_wrong_email: t('邮箱填错了？', 'Wrong address?'),
  verify_reregister: t('重新注册', 'Register again'),
  verify_ask_title: t('重新发送验证邮件', 'Send the verification email again'),
  verify_ask_text: t(
    '输入注册时用的邮箱，我们会重新发送。',
    "Enter the email you registered with and we'll send it again.",
  ),
  verify_ask_action: t('发送验证邮件', 'Send verification email'),
  verify_confirm_title: t('确认验证邮箱', 'Confirm your email'),
  verify_confirm_text: t(
    '点下面的按钮完成验证。这一步需要你亲自确认，邮件扫描器打开链接不会消耗它。',
    "Press the button below to finish. This step needs you to confirm; a mail scanner opening the link doesn't use it up.",
  ),
  verify_confirm_action: t('确认验证', 'Confirm'),
  verify_done_title: t('邮箱已验证', 'Email verified'),
  verify_done_text: t('现在可以登录了。', 'You can sign in now.'),
  verify_done_action: t('去登录', 'Go to sign in'),
  verify_invalid_title: t('这个链接不能用了', "This link can't be used"),
  verify_invalid_text: t(
    '它可能已经过期（1 小时有效）、已经用过，或者你又重发过验证邮件。',
    'It may have expired (it lasts an hour), been used already, or been replaced when you asked for a new email.',
  ),
  verify_invalid_action: t('重新发送验证邮件', 'Send a new verification email'),

  // ── forgot / reset ──
  forgot_page_title: t('找回密码', 'Reset password'),
  forgot_title: t('找回密码', 'Forgot your password?'),
  forgot_lead: t(
    '输入注册时用的邮箱，我们会发一封重置密码的邮件。',
    "Enter the email you registered with and we'll send a reset link.",
  ),
  forgot_submit: t('发送重置邮件', 'Send reset email'),
  forgot_back_to_login: t('回到登录', 'Back to sign in'),
  forgot_sent_title: t('检查你的邮箱', 'Check your inbox'),
  forgot_sent_text: t(
    '如果这个邮箱已经注册，你会收到一封重置密码的邮件。链接 1 小时内有效，只能使用一次。',
    "If this address has an account, you'll receive a reset email. The link works for one hour and only once.",
  ),
  forgot_sent_note: t(
    '没收到？先看看垃圾邮件文件夹。出于安全，我们不会告诉你这个邮箱是否注册过。',
    "Nothing arrived? Check your spam folder. For security we don't say whether the address has an account.",
  ),
  reset_page_title: t('设置新密码', 'Set a new password'),
  reset_title: t('设置新密码', 'Set a new password'),
  reset_lead: t(
    '至少 10 位，不能是常见弱密码。',
    'At least 10 characters, and not a commonly used password.',
  ),
  reset_new_password: t('新密码', 'New password'),
  reset_again: t('再输入一次', 'Repeat the password'),
  reset_mismatch: t('两次输入的密码不一样。', "The two passwords don't match."),
  reset_effect: t(
    '重置后，所有设备的登录会被注销，由这些设备发起的未完成任务也会被取消。',
    'After the reset every device is signed out, and unfinished work started from those devices is cancelled.',
  ),
  reset_submit: t('重置密码', 'Reset password'),
  reset_done_title: t('密码已重置', 'Password reset'),
  reset_done_text: t(
    '所有设备都已退出登录。请用新密码登录。',
    'Every device has been signed out. Sign in with the new password.',
  ),
  reset_invalid_title: t('这个链接不能用了', "This link can't be used"),
  reset_invalid_text: t(
    '它可能已经过期（1 小时有效）或已经用过。请重新申请一封重置邮件。',
    'It may have expired (it lasts an hour) or been used. Ask for a new reset email.',
  ),
  reset_invalid_action: t('重新申请重置邮件', 'Request a new reset email'),

  // ── shell ──
  shell_skip_to_content: t('跳到主要内容', 'Skip to main content'),
  shell_sidebar_label: t('会话', 'Conversations'),
  shell_search_placeholder: t('搜索或跳转…', 'Search or jump to…'),
  shell_search_aria: t('搜索、跳转或执行命令', 'Search, jump or run a command'),
  shell_empty_title: t('还没有会话', 'No conversations yet'),
  shell_empty_text: t(
    '聊天功能正在开发中，敬请期待。',
    'Chat is still being built. Check back soon.',
  ),
  shell_user_menu: t('{name}，账号设置', '{name}, account settings'),
  shell_settings: t('设置', 'Settings'),
  shell_open_menu: t('打开导航', 'Open navigation'),
  shell_splitter_label: t(
    '调整侧栏宽度，左右方向键移动',
    'Resize the sidebar; use the left and right arrow keys',
  ),
  shell_inspector_label: t('详情与助手', 'Details and assistant'),
  shell_inspector_details: t('详情', 'Details'),
  shell_inspector_assistant: t('助手', 'Assistant'),
  shell_inspector_close: t('关闭面板', 'Close panel'),
  shell_inspector_details_title: t('会话详情', 'Conversation details'),
  shell_inspector_details_text: t(
    '打开一个会话后，这里显示成员和会话设置。',
    'Members and conversation settings appear here once you open a conversation.',
  ),
  shell_inspector_assistant_title: t('助手面板', 'Assistant panel'),
  shell_inspector_assistant_text: t(
    '助手功能还在开发中，之后可以在这里总结讨论、起草回复和查找消息。',
    "The assistant is still being built. Later you'll be able to summarize discussions, draft replies and find messages here.",
  ),
  shell_assistant_panel: t('助手面板', 'Assistant panel'),
  shell_more: t('更多', 'More'),
  shell_menu_palette: t('命令面板', 'Command palette'),
  shell_menu_shortcuts: t('键盘快捷键', 'Keyboard shortcuts'),
  welcome_title: t('欢迎回来，{name}', 'Welcome back, {name}'),
  welcome_text: t(
    '聊天功能正在开发中。你可以先在设置里调整外观、管理登录设备和邀请码，或者用命令面板快速找到它们。',
    'Chat is still being built. For now you can adjust the look and manage your devices and invitations in Settings, or find them quickly with the command palette.',
  ),
  not_found_title: t('找不到这个页面', 'Page not found'),
  not_found_text: t(
    '这个地址不存在，或者你没有权限查看。',
    "This address doesn't exist, or you don't have access to it.",
  ),
  not_found_action: t('回到首页', 'Back to start'),
  route_error_title: t('页面出错了', 'This page hit a problem'),
  route_error_text: t(
    '请重试一次；如果仍然出错，请稍后再来。',
    'Try once more. If it keeps happening, come back later.',
  ),

  // ── shortcuts and palette ──
  shortcuts_title: t('键盘快捷键', 'Keyboard shortcuts'),
  shortcuts_lead: t(
    '所有功能也都能在命令面板里找到。',
    'Everything is also available from the command palette.',
  ),
  shortcut_palette: t('命令面板', 'Command palette'),
  shortcut_assistant: t('打开或关闭助手面板', 'Open or close the assistant panel'),
  shortcut_settings: t('设置', 'Settings'),
  shortcut_help: t('快捷键帮助', 'Keyboard shortcut help'),
  shortcut_escape: t('关闭弹层', 'Close a dialog'),
  palette_title: t('命令面板', 'Command palette'),
  palette_placeholder: t(
    '输入要做的事，例如“设置”“深色”…',
    'Type what you want to do, like “settings” or “dark”…',
  ),
  palette_empty: t('没有匹配的命令', 'No matching commands'),
  palette_hint_move: t('移动', 'move'),
  palette_hint_run: t('执行', 'run'),
  palette_hint_close: t('关闭', 'close'),
  palette_group_go: t('跳转', 'Go to'),
  palette_group_appearance: t('外观', 'Appearance'),
  palette_group_account: t('账号', 'Account'),
  palette_open_appearance: t('打开外观设置', 'Open appearance settings'),
  palette_open_account: t('打开账号设置', 'Open account settings'),
  palette_open_invites: t('打开邀请设置', 'Open invitation settings'),
  palette_theme_light: t('切换到浅色', 'Switch to light'),
  palette_theme_dark: t('切换到深色', 'Switch to dark'),
  palette_theme_system: t('跟随系统外观', 'Follow the system appearance'),

  // ── settings: shell ──
  settings_title: t('设置', 'Settings'),
  settings_tab_appearance: t('外观', 'Appearance'),
  settings_tab_account: t('账号', 'Account'),
  settings_tab_invites: t('邀请', 'Invitations'),

  // ── settings: appearance ──
  settings_preview_title: t('项目组', 'Project team'),
  settings_preview_line: t('Alice：图标草案…', 'Alice: icon draft…'),
  settings_preview_in: t('深色的气泡对比度测了', 'Checked the dark bubbles'),
  settings_preview_out: t('5.7，可以过', '5.7, that passes'),
  settings_theme: t('主题', 'Theme'),
  settings_theme_mode: t('外观模式', 'Appearance mode'),
  settings_theme_mode_help: t(
    '跟随系统时，会随系统的浅色和深色自动切换。',
    'Following the system switches between light and dark with it.',
  ),
  settings_theme_light: t('浅色', 'Light'),
  settings_theme_dark: t('深色', 'Dark'),
  settings_theme_system: t('跟随系统', 'System'),
  settings_accent: t('强调色', 'Accent colour'),
  accent_blue: t('蓝', 'Blue'),
  accent_purple: t('紫', 'Purple'),
  accent_pink: t('粉', 'Pink'),
  accent_red: t('红', 'Red'),
  accent_orange: t('橙', 'Orange'),
  accent_yellow: t('黄', 'Yellow'),
  accent_green: t('绿', 'Green'),
  accent_graphite: t('石墨', 'Graphite'),
  settings_accent_help: t(
    '气泡、按钮和徽标使用对应的可读配色，每一种都按 4.5:1 校验过。',
    'Bubbles, buttons and badges use a readable variant of each colour; every one is checked for 4.5:1 contrast.',
  ),
  settings_glass: t('透明度', 'Transparency'),
  settings_glass_material: t('玻璃材质', 'Glass material'),
  settings_glass_help: t(
    '只有导航层使用玻璃，消息列表始终是实底。',
    'Only the navigation layer uses glass; the message list is always solid.',
  ),
  settings_glass_system_off: t(
    '系统已开启“减少透明度”，已自动使用不透明。',
    'The system has “Reduce transparency” on, so opaque is used.',
  ),
  settings_glass_clear: t('清透', 'Clear'),
  settings_glass_standard: t('标准', 'Standard'),
  settings_glass_tinted: t('着色', 'Tinted'),
  settings_glass_opaque: t('不透明', 'Opaque'),
  settings_text_motion: t('文字与动效', 'Text and motion'),
  settings_type_size: t('界面字号', 'Text size'),
  settings_type_size_help: t(
    '整体放大或缩小，范围 −1 到 +3 档。',
    'Makes everything larger or smaller, from −1 to +3 steps.',
  ),
  settings_type_size_current: t('当前字号', 'Current size'),
  settings_type_default: t('默认', 'Default'),
  settings_type_plus: t('+{step} 档', '+{step}'),
  settings_type_minus: t('−{step} 档', '−{step}'),
  settings_reduce_motion: t('减少动态效果', 'Reduce motion'),
  settings_reduce_motion_help: t(
    '所有动画改成不超过 150 毫秒的淡入淡出。',
    'Every animation becomes a fade of at most 150 ms.',
  ),
  settings_reduce_motion_system: t(
    '系统已开启“减少动态效果”。',
    'The system has “Reduce motion” on.',
  ),
  settings_sidebar_preview: t('侧栏显示消息预览', 'Show message previews in the sidebar'),
  settings_sidebar_preview_help: t('关闭后侧栏更紧凑。', 'Turn off for a more compact sidebar.'),
  settings_language: t('语言', 'Language'),
  settings_language_label: t('界面语言', 'Interface language'),
  settings_language_help: t('切换后页面会重新载入。', 'The page reloads after switching.'),
  settings_reset: t('恢复默认外观', 'Restore default appearance'),
  settings_reset_done: t('已恢复默认外观', 'Appearance restored'),

  // ── settings: account ──
  settings_profile: t('资料', 'Profile'),
  settings_profile_name: t('显示名', 'Display name'),
  settings_profile_username: t('用户名', 'Username'),
  settings_profile_email: t('邮箱', 'Email'),
  settings_profile_email_help: t(
    '登录和找回密码用。',
    'Used to sign in and to reset your password.',
  ),
  settings_profile_later: t(
    '修改显示名、用户名和头像会在后续版本提供。',
    'Changing your display name, username and picture comes in a later version.',
  ),
  settings_signin: t('登录方式', 'Ways to sign in'),
  settings_password: t('密码', 'Password'),
  settings_password_help: t(
    '修改后，其他设备会被注销。',
    'Changing it signs out your other devices.',
  ),
  settings_password_change: t('修改密码…', 'Change password…'),
  settings_password_title: t('修改密码', 'Change password'),
  settings_password_current: t('当前密码', 'Current password'),
  settings_password_new: t('新密码', 'New password'),
  settings_password_submit: t('修改密码', 'Change password'),
  settings_password_wrong: t('当前密码不对。', 'The current password is wrong.'),
  settings_password_effect: t(
    '修改后，其他设备的登录会话会全部注销，由这些设备发起的未完成任务会被取消。',
    'After the change every other device is signed out, and unfinished work started from them is cancelled.',
  ),
  settings_password_changed: t(
    '密码已修改，其他设备已注销',
    'Password changed; your other devices were signed out',
  ),
  settings_passkey: t('Passkey', 'Passkey'),
  settings_passkey_help: t(
    '用指纹、人脸或设备锁屏登录，不需要输入密码。',
    'Sign in with a fingerprint, your face or your device lock instead of a password.',
  ),
  settings_passkey_unsupported: t(
    '这个浏览器或设备不支持 Passkey。',
    "This browser or device doesn't support passkeys.",
  ),
  settings_passkey_add: t('添加', 'Add'),
  settings_passkey_added: t('{date} 添加', 'Added {date}'),
  settings_passkey_added_toast: t('Passkey 已添加', 'Passkey added'),
  settings_passkey_unnamed: t('未命名的 Passkey', 'Unnamed passkey'),
  settings_passkey_name: t('名称', 'Name'),
  settings_passkey_rename: t('重命名', 'Rename'),
  settings_passkey_rename_title: t('重命名 Passkey', 'Rename passkey'),
  settings_passkey_remove: t('移除', 'Remove'),
  settings_passkey_remove_title: t('移除“{name}”？', 'Remove “{name}”?'),
  settings_passkey_remove_text: t(
    '移除后，这个 Passkey 不能再用来登录。你仍然可以用密码登录。',
    'This passkey can no longer be used to sign in. You can still sign in with your password.',
  ),
  settings_passkey_removed: t('Passkey 已移除', 'Passkey removed'),
  settings_devices: t('登录设备', 'Signed-in devices'),
  settings_devices_active: t('最近活动 {time}', 'Last active {time}'),
  settings_devices_current: t('此设备', 'This device'),
  settings_devices_unknown: t('未知设备', 'Unknown device'),
  settings_devices_privacy: t(
    'IP 和浏览器标识只有你本人能看到，会话结束后即删除。',
    'Only you can see the IP address and browser; they are deleted when the session ends.',
  ),
  settings_devices_revoke: t('注销', 'Sign out'),
  settings_devices_revoke_others: t('注销其他所有设备…', 'Sign out all other devices…'),
  settings_devices_revoke_all: t('在所有设备上退出…', 'Sign out everywhere…'),
  settings_devices_revoke_one_title: t('注销“{name}”？', 'Sign out “{name}”?'),
  settings_devices_revoke_others_title: t('注销其他所有设备？', 'Sign out all other devices?'),
  settings_devices_revoke_all_title: t('在所有设备上退出登录？', 'Sign out on every device?'),
  settings_devices_revoke_text: t(
    '这些设备会被立即断开，需要重新登录。',
    'These devices are disconnected at once and have to sign in again.',
  ),
  settings_devices_revoke_all_text: t(
    '包括这台设备在内的所有设备都会被立即断开，需要重新登录。',
    'Every device, including this one, is disconnected at once and has to sign in again.',
  ),
  settings_devices_revoke_effect: t(
    '由这些设备发起、还没完成的助手任务和提醒会被取消，取消后不会自动恢复。',
    'Assistant tasks and reminders started from these devices and not finished yet are cancelled, and are not restored.',
  ),
  settings_devices_signout_note: t(
    '普通退出登录不会取消已授权的任务；只有注销设备、改密码、重置密码、封禁等安全操作才会。',
    'A normal sign-out does not cancel authorized tasks; only security actions such as signing a device out, changing or resetting the password, or a ban do.',
  ),
  settings_devices_revoke_confirm: t('注销', 'Sign out'),
  settings_devices_revoke_all_confirm: t('全部退出', 'Sign out everywhere'),
  settings_devices_revoked: t(
    '已注销，对方会在几秒内被踢回登录页',
    'Signed out; that device returns to the sign-in page within seconds',
  ),
  settings_timezone: t('时区', 'Time zone'),
  settings_timezone_mode: t('聊天与提醒使用的时区', 'Time zone for chat and reminders'),
  settings_timezone_mode_help: t(
    '固定后，聊天时间、助手理解“明天上午”和提醒确认都用这个时区，其他设备不能自动覆盖。',
    'When fixed, chat times, “tomorrow morning” and reminder confirmations use this zone, and no other device overrides it.',
  ),
  settings_timezone_auto: t('跟随浏览器', 'Follow browser'),
  settings_timezone_fixed: t('固定', 'Fixed'),
  settings_timezone_current_auto: t('当前（来自浏览器）', 'Current (from this browser)'),
  settings_timezone_current_fixed: t('固定为', 'Fixed to'),
  settings_timezone_now: t('现在是 {time}', 'It is now {time}'),
  settings_timezone_note: t(
    '额度按 Asia/Shanghai 重置，与这里的显示时区无关。夏令时中不存在或重复的时间，设置提醒时会要求你明确选择。',
    'Daily limits reset on Asia/Shanghai time regardless of this setting. For times that do not exist or happen twice around daylight saving changes, you are asked to choose when you set a reminder.',
  ),
  settings_timezone_saved: t('时区已更新', 'Time zone updated'),
  settings_timezone_conflict: t(
    '设置刚在别处被修改了，已显示最新内容，请再试一次。',
    'Your settings changed elsewhere. The latest are shown now; try again.',
  ),
  settings_sign_out: t('退出登录', 'Sign out'),
  settings_sign_out_help: t(
    '只退出这台设备。你已经授权的助手任务和提醒会继续执行。',
    'Signs out this device only. Assistant tasks and reminders you already authorized keep running.',
  ),

  // ── settings: invitations ──
  invites_quota: t('名额', 'Slots'),
  invites_quota_admin: t(
    '管理员可以生成任意数量的邀请码。',
    'Administrators can create any number of invitation codes.',
  ),
  invites_quota_label: t('邀请名额', 'Invitation slots'),
  invites_quota_used: t('已占用', 'Used'),
  invites_quota_left: plural('count', '还剩 {count} 个', '{count} left', '{count} left'),
  invites_create: t('生成邀请码', 'Create an invitation code'),
  invites_expiry: t('有效期', 'Valid for'),
  invites_expiry_help: t('默认 7 天，可以调整。', '7 days by default.'),
  invites_days: plural('count', '{count} 天', '{count} day', '{count} days'),
  invites_uses: t('可使用次数', 'Number of uses'),
  invites_uses_help: t(
    '默认只能用 1 次。有人用它注册时占用你的一个名额。',
    'One use by default. Each registration with it takes one of your slots.',
  ),
  invites_times: plural('count', '{count} 次', '{count} time', '{count} times'),
  invites_note: t('备注（可选）', 'Note (optional)'),
  invites_note_help: t(
    '只有你自己能看到，方便记得发给了谁。',
    'Only you see it, to remember who it was for.',
  ),
  invites_create_action: t('生成邀请码', 'Create code'),
  invites_created_title: t('邀请码已生成', 'Invitation code created'),
  invites_created_once: t(
    '这个邀请码的明文只显示这一次，离开后只能撤销、不能再看。',
    'The code is shown only now. After you leave you can revoke it but not see it again.',
  ),
  invites_created_link: t('注册链接', 'Registration link'),
  invites_created_link_help: t(
    '邀请码在 # 后面，不会发到服务器。',
    'The code comes after #, which is never sent to the server.',
  ),
  invites_created_note: t(
    '有人用它注册时占用你的一个名额；对应账号被清理或撤销时名额退回。',
    'Each registration with it takes one of your slots; the slot comes back if that account is cleaned up or revoked.',
  ),
  invites_mine: t('我的邀请码', 'My invitation codes'),
  invites_none: t('还没有邀请码。', 'No invitation codes yet.'),
  invites_row_title: t('{date} 生成的邀请码', 'Code created {date}'),
  invites_row_expires: t('{date} 到期', 'expires {date}'),
  invites_row_used: t('已用 {used}', 'used {used}'),
  invites_status_active: t('有效', 'Active'),
  invites_status_revoked: t('已撤销', 'Revoked'),
  invites_status_expired: t('已过期', 'Expired'),
  invites_status_used: t('已用完', 'Used up'),
  invites_revoke: t('撤销', 'Revoke'),
  invites_revoked_toast: t(
    '已撤销，这个邀请码不能再用了',
    'Revoked; the code can no longer be used',
  ),
  invites_pending: t('还没有验证邮箱的注册', 'Registrations not yet verified'),
  invites_pending_none: t('没有等待验证的注册。', 'No registrations waiting for verification.'),
  invites_registration_unnamed: t('未命名的注册', 'Unnamed registration'),
  invites_registration_help: t(
    '{date} 注册，还没有验证邮箱。你只能看到用户名，看不到对方的邮箱。',
    'Registered {date}, email not verified. You see only the username, not the email address.',
  ),
  invites_registration_revoke: t('撤销注册', 'Revoke registration'),
  invites_registration_revoke_title: t(
    '撤销 {name} 的注册？',
    'Revoke the registration of {name}?',
  ),
  invites_registration_revoke_text: t(
    '账号会被删除，占用的名额退回给你。对方如果已经收到验证邮件，链接不会再生效。',
    'The account is deleted and the slot returns to you. If they already received the verification email, its link stops working.',
  ),
  invites_registration_revoked: t('已撤销，名额已退回', 'Revoked; the slot is back'),
}
