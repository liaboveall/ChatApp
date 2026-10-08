/** New synthetic conversations and query intents, frozen before either local model's held-out retrieval is examined. */
import { uuidV5 } from '../src/lib/crypto.ts'
import type { EvalQuery } from './dataset.ts'

const topics = [
  ['发布', '把服务切到新的版本', '新版服务已经完成灰度，今晚切换生产流量'],
  ['迁移', '把旧数据搬到新的库', '历史记录已转移到新的数据库，旧库保留只读'],
  ['备份', '留一份可恢复的数据副本', '业务数据副本每天保存一次，可以恢复'],
  ['压测', '模拟很多人同时访问', '用一千名虚拟用户同时访问接口，检查吞吐量'],
  ['审计', '核查是谁做过哪些操作', '每条管理操作都记录操作者和发生时间'],
  ['告警', '故障时及时提醒值班人', '服务错误超过阈值会通知值班同事'],
  ['登录', '让成员进入自己的账号', '成员通过密码和设备凭证进入个人账户'],
  ['图片', '查看聊天里的照片', '聊天上传的照片可以打开缩略图和原图'],
  ['视频', '播放一段录制的影像', '上传的录制影像在消息里可以播放'],
  ['邀请', '把新同事带进讨论组', '新同事通过邀请链接加入团队讨论'],
  ['缓存', '把常用数据临时放在近处', '经常读取的结果暂存在内存里，减少数据库查询'],
  ['限流', '控制接口收到请求的速度', '接口按每人的请求频率拒绝超量访问'],
  ['账单', '核对供应商收取的费用', '供应商收取的金额需要逐条和使用记录对上'],
  ['报销', '归还同事垫付的费用', '同事垫付的交通费用提交凭证后返还'],
  ['采购', '给团队购买设备', '团队需要购买一台新的工作电脑'],
  ['回滚', '恢复到上一个稳定版本', '新版本有故障时恢复到之前稳定的服务版本'],
  ['轮值', '安排大家轮流负责值班', '每名工程师按顺序承担一周的值班工作'],
  ['培训', '教新成员掌握工作流程', '新成员将学习团队的操作流程和协作方法'],
  ['排期', '确定各项工作的执行顺序', '各项工作安排了开始日和完成日'],
  ['合规', '检查是否符合规定', '业务处理流程需要符合内部规章的要求'],
  ['验收', '确认交付是否满足约定', '交付的功能要逐项确认符合事先约定'],
  ['续约', '继续签订服务合同', '现有服务合同到期后再签一年'],
  ['入库', '把到货物品登记到库存', '已经收到的设备登记数量并放进仓库'],
  ['结算', '付清应付的款项', '已经确认的供应商应付款项统一支付'],
] as const
const people = [
  '林舟',
  '赵雨',
  '王青',
  '陈宁',
  '孙杰',
  '吴瑶',
  '周明',
  '黄悦',
  '许文',
  '何芮',
  '杜洋',
  '郑晓',
  '苏月',
  '梁川',
  '方静',
  '秦桐',
  '唐羽',
  '郭安',
  '蒋然',
  '谢峰',
  '叶秋',
  '徐星',
  '邵南',
  '陆微',
]
export function m5Corpus() {
  const conversations = topics.map((_, i) => ({
    id: uuidV5(`m5-corpus-conversation:${i}`),
    ownerId: uuidV5(`m5-corpus-person:${i}`),
    name: `新语料${i + 1}组`,
    split: i < 16 ? ('dev' as const) : ('holdout' as const),
    person: people[i] ?? '测试同事',
    date: `2026-11-${String(1 + i).padStart(2, '0')}`,
    visibleFromSeq: 5,
  }))
  const messages = conversations.flatMap((c, i) =>
    Array.from({ length: 100 }, (_, n) => {
      const seq = n + 1,
        t = topics[i] ?? topics[0]
      const target = `${t[0]}安排：${t[2]}。负责人${c.person}，确认日期${c.date}。此事项尚未批准，不能说已经执行。`
      const body =
        seq <= 8
          ? `CANARY_${seq}_${i} ${target}`
          : seq === 12
            ? target
            : seq === 13
              ? `${c.person}负责核对工作进展，另有一位同名同事只负责例会签到。`
              : seq === 14
                ? '本组明确否决了无人确认就自动执行的建议。'
                : seq === 15
                  ? `${'今天记录的是例行沟通。'.repeat(90)}长消息末尾的补充：${t[0]}必须先保留原有数据，不要删除历史记录。`
                  : `例行签到第${seq}条：成员记录了会议室座位、咖啡杯颜色和午餐点单${i}-${seq}，暂无新的业务决定。`
      return {
        id: uuidV5(`m5-corpus-message:${i}:${seq}`),
        conversationId: c.id,
        seq,
        body,
        visibility:
          seq <= 5
            ? 'before_join'
            : seq === 6
              ? 'recalled'
              : seq === 7
                ? 'byok_private'
                : seq === 8
                  ? 'hidden'
                  : 'visible',
      }
    }),
  )
  const queries: EvalQuery[] = []
  const relevant = (i: number, seq: number, grade: 1 | 2 = 2) => ({
    messageId: uuidV5(`m5-corpus-message:${i}:${seq}`),
    grade,
  })
  for (const [i, c] of conversations.entries()) {
    const t = topics[i] ?? topics[0]
    const basics: [EvalQuery['category'], string, EvalQuery['relevance']][] = [
      ['short', t[0], [relevant(i, 12), relevant(i, 15, 1)]],
      ['person', c.person, [relevant(i, 12), relevant(i, 13, 1)]],
      ['time', c.date, [relevant(i, 12)]],
      ['synonym', t[1], [relevant(i, 12)]],
    ]
    // Development 80: 60 answerable / 20 no-answer. Holdout 40: 28 answerable / 12 no-answer.
    const noAnswer = i === 14 || i === 15 || i === 22 || i === 23
    const selected = noAnswer
      ? [
          ...basics.slice(0, 2),
          ['no_answer', `CANARY_7_${i} 私有内容`, []],
          ['no_answer', '南极考察队的晚餐菜单', []],
        ]
      : basics
    for (const [j, [category, query, relevance]] of selected.entries())
      queries.push({
        id: `m5-${c.split}-${i}-${j}`,
        split: c.split,
        intentGroup: `m5-${c.split}-${i}-${category}`,
        conversationId: c.id,
        category: category as EvalQuery['category'],
        query: query as string,
        toolQuery: query as string,
        relevance: relevance as EvalQuery['relevance'],
      })
    queries.push({
      id: `m5-${c.split}-${i}-4`,
      split: c.split,
      intentGroup: `m5-${c.split}-${i}-noanswer`,
      conversationId: c.id,
      category: 'no_answer',
      query: '有没有关于火星登陆舱燃料的决定',
      toolQuery: '有没有关于火星登陆舱燃料的决定',
      relevance: [],
    })
  }
  const independent = [
    ['我喜欢在上午九点开始工作。', '我习惯几点开始工作？', '我的工作日何时开始？'],
    ['联系我时请优先使用电子邮件。', '用什么方式联系我最合适？', '我偏好的联络方式是什么？'],
    ['阅读文档时我喜欢使用大字号字体。', '怎样设置文字更适合我阅读？', '我的字体大小偏好是什么？'],
    [
      '请在晚上十点之后把消息通知静音。',
      '我希望何时开始不受通知打扰？',
      '夜间什么时候要关闭消息提示？',
    ],
  ]
  const memories = conversations.slice(0, 12).map((c, i) => ({
    ownerId: c.ownerId,
    conversationId: c.id,
    id: uuidV5(`m5-memory:${i}`),
    content:
      i < 8
        ? `我喜欢${['绿茶', '黑咖啡', '乌龙茶', '茉莉花茶', '柠檬水', '牛奶', '红茶', '可可'][i]}，开会时请为我准备这种饮品。`
        : (independent[i - 8]?.[0] ?? ''),
    queries:
      i < 8
        ? ['开会为我准备什么喝的？', '我喜欢喝哪种饮品？']
        : [independent[i - 8]?.[1] ?? '', independent[i - 8]?.[2] ?? ''],
    split: i < 8 ? ('dev' as const) : ('holdout' as const),
  }))
  // 60 independent queries, 40 development / 20 holdout; every held-out owner has 3 no-answer requests.
  const memoryQueries = memories.flatMap((m, i) => [
    {
      id: `memory-${i}-0`,
      ownerId: m.ownerId,
      split: m.split,
      query: m.queries[0] ?? '',
      relevant: [m.id],
    },
    {
      id: `memory-${i}-1`,
      ownerId: m.ownerId,
      split: m.split,
      query: m.queries[1] ?? '',
      relevant: [m.id],
    },
    ...['我家的门牌号码是多少？', '我的银行卡开户行是哪家？', '我养的宠物叫什么名字？'].map(
      (query, j) => ({
        id: `memory-${i}-${j + 2}`,
        ownerId: m.ownerId,
        split: m.split,
        query,
        relevant: [],
      }),
    ),
  ])
  return { conversations, messages, queries, memories, memoryQueries }
}
