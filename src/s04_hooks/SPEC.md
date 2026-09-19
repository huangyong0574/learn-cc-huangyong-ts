# S04 Hooks 机制 SPEC（设计规格与原理详解）

> 参考实现：`../../../learn-claude-code/s04_hooks/code.py`

---

## 1. 背景与动机：为什么需要 Hooks

### 1.1 s03 的问题

s03 的权限检查是**硬编码**在 agent loop 里的：

```
agent loop 里写死: if (!checkPermission(block)) { 拒绝; continue; }
```

后果：

- **每加一个横切功能（日志、审计、限流），都要改 loop 本体**——loop 越来越臃肿
- 权限逻辑和业务循环**耦合**：想把权限换成"审计模式"，必须动 loop
- 测试困难：权限逻辑无法独立验证

类比：相当于把"安检"直接焊死在机场跑道里，而不是放在登机口——想加海关检查就得修跑道。

### 1.2 解决思路

把"在某个时刻执行某逻辑"抽象成三件事：

1. **定义时刻**（事件）：工具执行前、用户输入时……
2. **登记逻辑**（注册）：把函数挂到某个时刻上
3. **到达时刻时统一触发**（分发）：loop 只管喊"到点了"，不关心喊到谁

这就是 **Hooks = 事件驱动的回调系统**。

---

## 2. 总体架构

```
用户输入
   │
   ▼
[UserPromptSubmit]  ←── 钩子时机1：输入提交时
   │
   ▼
┌────────┐     ┌─────┐     ┌────────────┐     ┌──────┐
│messages│────▶│ LLM │────▶│[PreToolUse]│────▶│ Tool │
└────────┘     └──┬──┘     │ 权限 / 日志 │     └──┬───┘
     ▲            │        └────────────┘        │
     │            │ stop                          ▼
     │            ▼                        [PostToolUse]
     │        [Stop] ←── 钩子时机4            输出告警
     │         统计/强制续跑                       │
     └──────────────── tool_result ──────────────┘
```

**四个事件点**覆盖 Agent 生命周期的全部关键缝隙：输入入口、工具前、工具后、会话出口。

---

## 3. 核心组件详解

### 3.1 事件表 `HOOKS`（数据中心）

```typescript
const HOOKS: { [K in HookEvent]: HookCallbackMap[K][] } = {
    UserPromptSubmit: [],
    PreToolUse: [],
    PostToolUse: [],
    Stop: [],
};
```

- **本质**：一个以事件名为键、以回调数组为值的字典——每个事件一个"插槽"
- 类比：酒店前台的寄存柜，4 个格子（事件），每个格子能放多张房卡（回调），按存入顺序排
- **空数组初始化**很重要：任何事件都能安全遍历，不需要判空

### 3.2 `registerHook`（注册）

```
输入: 事件名 + 回调函数
行为: 把回调追加进对应事件的数组
输出: 无
```

- 类比：把房卡放进寄存柜的某个格子
- **注册顺序 = 执行顺序**：先注册的先执行（`permissionHook` 必须在 `logHook` 之前，被拦截的调用就不该打日志）

### 3.3 `triggerHooks`（分发器，整个机制的心脏）

伪代码逻辑：

```
对事件数组里的每个回调，按顺序执行：
    result = 回调(args...)
    如果 result 非 null：
        立即返回 result          ← 短路！后面的回调不再执行
    否则：继续下一个回调
全部通过 → 返回 null
```

**两个关键设计**：

| 设计       | 含义                                   | 类比                       |
| ---------- | -------------------------------------- | -------------------------- |
| 顺序执行   | 按注册序逐个调用                       | 机场安检一道道过           |
| **非 null 短路** | 任何一个回调"说话"（返回拦截理由），后续全部跳过 | 第一道安检拦下了，后面不用查了 |

---

## 4. 拦截契约（最重要的协议）

整个机制靠一个**返回值约定**运转：

```
回调返回 null      → "我没意见"，放行，继续下一个回调
回调返回非 null    → "我要拦截"，内容是拦截理由（字符串），立即短路
```

这个约定的三个妙处：

1. **理由可传播**：拦截理由作为字符串原样回填给模型（`tool_result: String(blocked)`），模型知道是"黑名单拦的"还是"用户否的"，能据此换策略——比 s03 的统一 "Permission denied." 信息量大得多
2. **无返回值即放行**：日志、统计这类"只看不管"的钩子统一返回 `null`，天然无害，随便叠加
3. **多回调协同**：多个 `PreToolUse` 钩子组成"检查链"，任意一个不满意都能叫停

---

## 5. 四个事件的契约细节

| 事件                 | 回调入参                 | 拦截效果                             | 非拦截返回值用途 |
| -------------------- | ------------------------ | ------------------------------------ | ---------------- |
| `UserPromptSubmit`   | `query: string`          | 理论可拦（当前实现不拦）             | —                |
| `PreToolUse`         | `block: ToolUseBlock`    | **阻断工具执行**，理由回给模型       | —                |
| `PostToolUse`        | `block, output`          | 工具已执行，无法撤回                 | 仅观察（告警）   |
| `Stop`               | `messages`               | **特殊：返回内容 = 强制续跑**        | 返回非空 → 塞回 messages 再跑一轮 |

**Stop 是唯一"反向"的事件**：其他事件返回非空是"拒绝"，Stop 返回非空是"挽留"——钩子可以在会话结束时塞一句话让模型继续干活。这是给"收尾检查"类钩子留的口子。

---

## 6. 五个钩子的职责（PY 原版清单）

| # | 钩子                | 事件               | 职责                                             | 拦截？ |
|---|---------------------|--------------------|--------------------------------------------------|--------|
| 1 | `contextInjectHook` | UserPromptSubmit   | 灰字打印工作目录，制造上下文感                   | 否     |
| 2 | `permissionHook`    | PreToolUse         | **s03 三道门搬家**：黑名单→破坏性关键词→路径越界 | ✅     |
| 3 | `logHook`           | PreToolUse         | 灰字打印每次调用（工具名+参数前 60 字符）        | 否     |
| 4 | `largeOutputHook`   | PostToolUse        | 输出超 10 万字符黄色告警                         | 否（不可逆） |
| 5 | `summaryHook`       | Stop               | 统计 messages 里 tool_result 数量                | 否     |

注册顺序（顺序即语义）：

```
UserPromptSubmit: [contextInjectHook]
PreToolUse:       [permissionHook, logHook]   ← 权限先，日志后（被拦的不打日志）
PostToolUse:      [largeOutputHook]
Stop:             [summaryHook]
```

---

## 7. 类型系统设计（TS 专属）

三层类型，逐层收紧：

**① 事件名白名单（枚举思想）**

```typescript
type HookEvent = "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";
```

写错事件名 → 编译报错。

**② 每个事件的回调签名（接口思想）**

```typescript
type HookCallbackMap = {
    UserPromptSubmit: (query: string) => Promise<string | null>;
    PreToolUse: (block: ToolUseBlock) => Promise<string | null>;
    PostToolUse: (block: ToolUseBlock, output: string) => Promise<string | null>;
    Stop: (messages: MessageParam[]) => Promise<string | null>;
};
```

**③ 泛型注册函数（类型焊死）**

```
registerHook 接受事件名 E，回调类型自动取 HookCallbackMap[E]
→ 注册 "PreToolUse" 时，回调参数必须是 ToolUseBlock，传错编译报错
```

**为什么回调返回 `Promise<string | null>` 而不是 `string | null`？**
这是 TS 版与 PY 版最大的结构差异，见下一节。

---

## 8. 异步传染性：TS 与 PY 的关键差异

PY 版全程同步（`input()` 阻塞等用户）。TS 项目里 `rl.question` 是异步的，于是：

```
askUser 需要 await → permissionHook 必须 async → 返回 Promise<string | null>
→ triggerHooks 必须 async（内部要 await 每个回调）
→ agentLoop 里调用点必须 await（本来就是）
→ registerHook 注册的回调类型必须允许 Promise 返回
```

**连锁规则**：只要任何一个钩子可能异步，整个分发链就必须异步。既然 `permissionHook` 注定异步，**所有钩子统一声明为 `Promise<string | null>`** 最干净——同步钩子直接 `return null` 也兼容（async 函数自动包 Promise）。

这是移植时最容易漏的点，写进 SPEC 防止遗漏。

---

## 9. Agent Loop 的三处改造（s03 → s04）

```
改造点1（工具执行前）:
  s03: if (!checkPermission(block)) { 塞"Permission denied."; continue; }
  s04: const blocked = await triggerHooks("PreToolUse", block);
       if (blocked) { 塞 String(blocked); continue; }
  → 理由从钩子带来，不再写死文案

改造点2（工具执行后，新增）:
  await triggerHooks("PostToolUse", block, output);

改造点3（循环退出前）:
  s03: if (stop_reason !== "tool_use") break;
  s04: if (stop_reason !== "tool_use") {
           const force = await triggerHooks("Stop", messages);
           if (force) { 塞 user 消息 force; continue; }  ← 强制续跑
           return;
       }

改造点4（主循环，用户输入后）:
  await triggerHooks("UserPromptSubmit", query);   ← history.push 之前
```

**改完后的 loop 里没有任何权限/日志字样**——所有横切逻辑都外挂，这就是"loop stays clean"。

---

## 10. 扩展性验证（开闭原则检验）

假设将来要加"敏感文件保护"钩子：

```
1. 写一个函数: sensitiveFileHook(block): 路径命中敏感清单 → 返回理由
2. registerHook("PreToolUse", sensitiveFileHook)
3. 完事。
```

**agent loop、现有 5 个钩子、类型系统，零改动。** 这就是 s03（写死）到 s04（可插拔）的本质跃迁。

---

## 11. 实施顺序（按依赖链）

```
① 类型（HookEvent 已有 → HookCallbackMap → HOOKS 表）
② 基础设施（registerHook → triggerHooks）
③ permissionHook（三道门逻辑原样搬，返回形态改为 理由字符串/null）
④ agentLoop 改造点1（先跑通"权限走钩子"这条主链路）
⑤ 其余 4 个钩子 + 注册
⑥ 改造点2/3/4 + 文案收尾
```

每步都能独立编译、独立验证——第④步完成时，行为应与 s03 完全一致（只是理由文案更具体），是最好的回归验证点。
