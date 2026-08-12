# learn-cc-huangyong-ts

手搓 TypeScript 版 [learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)。

**目的不是产出一个能用的 agent，是通过重写内化 Claude Code harness 的原理。**
复刻式重写比阅读更能暴露理解盲区——读代码时"看懂了"和自己写时"写不出来"之间的差距，就是真正要补的东西。

参考实现在同级目录 `../learn-claude-code/`（Python，17 章）。章节目录名与原版逐字一致，方便对照。

## 运行

```sh
cp .env.example .env        # 填 ANTHROPIC_API_KEY 和 MODEL_ID
npm install

node src/s01_agent_loop/code.ts    # 跑某一章
npm run check                       # 类型检查（tsc --noEmit）
npm test                            # node --test tests/
```

**没有 build 步骤。** Node 25 原生剥离类型注解，源码就是可执行的。

## 三条铁律

Node 的类型剥离 **只删不改、不跨文件**——它把类型注解替换成空白，不解析模块、不做类型推导、不看别的文件。三条限制都是这一句的推论：

| 规则 | 原因 | 编译期护栏 |
|---|---|---|
| import 必须写全 `.ts` 后缀 | import 字符串原样保留，运行时得按字面找到文件 | `allowImportingTsExtensions` |
| 类型导入必须写 `import type` | 剥离器不跨文件，不知道那个名字是类型还是值，只好保留 → 运行时找不到导出 | `verbatimModuleSyntax` |
| 不能用 `enum` / `namespace` / 参数属性 / 装饰器 | 这些要生成运行时代码，不是"删掉就行" | `erasableSyntaxOnly` |

`tsconfig.json` 里那三个选项就是把这些运行时崩溃提前成编辑器里的红波浪线。**先跑 `npm run check`，再跑 `node`。**

## 结构

```
src/
  shared/client.ts        # 全仓库唯一的跨章共享：读 .env + 建 client
  sXX_name/
    code.ts               # 独立可运行，不 import 其它章节
    NOTES.md              # 理解笔记 —— 这个工程真正的产出
tests/
```

**每章自包含。** 工具定义、权限、压缩逻辑一律各章重写一遍，不抽公共层——抽走了就变成"组装"，那正是要避开的学习方式。`shared/` 的唯一例外是建 client 那几行纯样板。

## 进度

| 章节 | 主题 | 关键概念 | 状态 |
|---|---|---|---|
| s01 | Agent Loop | `messages` / `while` / `stop_reason` | ☐ |
| s02 | Tool Use | 工具分发表 / 并发执行 | ☐ |
| s03 | Permission | 规则匹配 / 审批管线 | ☐ |
| s04 | Hooks | PreToolUse / PostToolUse | ☐ |
| s05 | TodoWrite | 先计划后执行 | ☐ |
| s06 | Subagent | 全新 messages[] / 上下文隔离 | ☐ |
| s07 | Skill Loading | 技能目录 / 按需注入 | ☐ |
| s08 | Context Compact | budget → snip → micro → summary | ☐ |
| s09 | Memory | selection / extraction / consolidation | ☐ |
| s10 | Task System | 落盘持久化 / blockedBy 依赖图 | ☐ |
| s11 | Background Tasks | 后台执行 / 通知队列 | ☐ |
| s12 | Cron Scheduler | 持久化调度 / 会话级触发 | ☐ |
| s13 | Agent Teams | 持久队友 / 原子认领 / worktree 隔离 | ☐ |
| s14 | MCP Plugin | 工具发现 / 命名空间 / 工具池组装 | ☐ |
| s15 | Integrated Harness | 全部机制回到同一个循环 | ☐ |
| s16 | Workflow Runtime | 脚本编排 / journal 续跑 | ☐ |
| s17 | Goal Loop | 目标闸门 / 自动续轮 | ☐ |

## 推进顺序

**不按 s01→s17 顺序爬。** s01–s08 几乎无阻力（纯逻辑 + SDK 调用），一口气推完建立肌肉记忆；然后**直接跳 s13**——它 1794 行、锁 + worktree + 邮箱全在里面，会倒逼你把 s10/s11/s12 的持久化和并发模型想清楚，比顺着爬效率高。

## 已知的「不能直译」清单

Python 原版给的是一个答案，Node 逼你重新设计。这些地方的取舍写进对应章的 `NOTES.md`：

- **`fcntl.flock` 文件锁**（s13 / s15 / s16）——多 agent 原子认领任务靠它。Node 没有等价物：要么用 mkdir/rename 的原子性自己造，要么改成单进程内存互斥。取决于队友是否真的跨进程。
- **`threading` 后台任务**（s11 / s12 / s13 / s15 / s16）——Node 是单线程事件循环，后台天然是 Promise/子进程。这是简化点，但**完成通知何时插回 messages** 需要重新设计。
- **同步 `subprocess` → 异步 `child_process`**（s02）——并发工具执行在 TS 里 `Promise.all` 就有了，但**结果顺序必须与 `tool_use` block 对应**，得自己保证。
- **`readline` 的 macOS UTF-8 退格补丁**（s01 顶部）——纯 Python 生态包袱，忽略。
