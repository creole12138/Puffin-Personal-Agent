# Puffin 云朵小管家 · Personal Agent 原型

> 个人 Agent 的核心不是"记住更多"，而是把分散、会变化的工作上下文，变成有来源、有边界、可校正、能跨时间续接的工作状态。详见 `PROBLEM_STATEMENT.md`。

## 快速开始

```bash
npm install
cp .env.example .env        # 填入 OPENAI_API_KEY（第一阶段模型：gpt-6-sol）
npm test                    # 影响传播的单元测试
npm run demo:ripple         # 命令行闭环（规则判断，不联网）
npm run llm:ping            # 检查模型是否连通
npm run demo:ripple -- --llm  # 用 gpt-6-sol 判断决策是否仍成立
npm start                   # 启动网页版：http://localhost:3000
```

> 项目放在开启了 iCloud「优化 Mac 储存空间」的桌面/文稿里时，`node_modules` 可能被转成云端占位文件导致启动卡住，`npm run boot:check` 可以诊断；建议把项目放在不同步 iCloud 的目录。

## 结构

```
app/core/src/
  types.ts            数据结构：证据、授权、前提、决策、动作、工作卡、事件
  provider/           多 Provider 抽象（第一阶段只实现 openai），带录制/回放
  engine/ripple.ts    前提变化 → 影响传播（确定性，依赖图遍历）
  engine/assessor.ts  决策是否仍成立：LLM 判断 / 规则兜底
  engine/events.ts    事件日志（时间线、回退、续接的基础）
  engine/store.ts     JSON 状态持久化
  seed.ts             演示场景：Q4 规划（预算 50 万 → 30 万）
```

LLM 只负责：从材料提取结构、判断新证据是否改变前提与决策、给替代建议。影响传播与按撤回成本分级（需要你决定 / 暂停 / 自动更新 / 起草补救）全部是确定性代码。

## 范围与后续计划

**本版包含**：在网页里上传或粘贴材料、在对话里描述目标、指定本机文件夹作为工作目录（Chrome/Edge）、日历 `.ics` 链接的变化监听；基于 Pi 的 Agent 循环、授权检查、工作状态与影响传播、时间线、导出与续接。

**暂不包含（下一步）**

- **邮件来源**。设想了两种接入方式：
  - *转发给 Agent*：每个工作区一个专属收件地址，用户只转发相关邮件。任何邮箱都能用，而且每封邮件都由用户决定给不给，最符合渐进授权（H3）。
  - *连接 Gmail*：Gmail 的读取权限属于 Google 的受限权限，应用在通过 Google 安全评估前只能对名单内的测试账号开放，因此不适合开放给任意访问者体验的原型。
- **后台监听本机文件夹**：浏览器只能在网页打开时读取所选文件夹；真正的后台监听需要一个本地伴随程序。
- **对外发送**：所有对外动作目前只起草，由用户确认后自己发送。
