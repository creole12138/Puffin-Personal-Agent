/**
 * Kimi 工作卡 Agent —— 核心数据结构（v0，2026-09-28）
 *
 * 设计原则：
 * - 状态比对话历史更重要：一切界面都从这些对象渲染，对话只是输入通道。
 * - 每个结论都能追溯到证据（Evidence），每个决策都显式记录它依赖的前提。
 * - 前提变化的影响传播靠依赖图的确定性遍历，不靠 LLM；LLM 只负责
 *   "从材料提取结构" 和 "判断新证据是否改变某个前提" 以及 "给替代建议"。
 * - 所有状态变更都写入 Event，时间线、回退、续接都基于事件日志。
 */

export type ID = string;
export type ISOTime = string;

/* ---------- 来源与证据 ---------- */

export type SourceKind = "user_input" | "local_folder" | "calendar" | "email";

/** 所有来源实现同一个接口：读取、监听、输出证据 */
export interface SourceAdapter {
  kind: SourceKind;
  /** 一次性读取（生成草稿卡时用） */
  read(scope: Grant): Promise<Evidence[]>;
  /** 持续监听，发现新增或变化时回调 */
  watch(scope: Grant, onEvidence: (e: Evidence) => void): () => void;
}

/** 归一化后的证据：邮件、日程、文件、用户的话都转成这个格式 */
export interface Evidence {
  id: ID;
  source: SourceKind;
  /** 指向原始位置：文件路径、邮件 id、日程 uid 等 */
  ref: string;
  title: string;
  /** 与判断相关的原文摘录，用于"依据"抽屉 */
  excerpt: string;
  observedAt: ISOTime;
  /** 同一 ref 的新版本会指向旧版本，用于识别"变化" */
  supersedes?: ID;
}

/* ---------- 授权（渐进授权，H3） ---------- */

export interface Grant {
  id: ID;
  source: SourceKind;
  /** 人能读懂的范围描述，如"只读含 Alex 或预算的邮件" */
  scopeLabel: string;
  /** 机器可用的过滤条件：目录、关键词、日历链接等 */
  filter: Record<string, unknown>;
  projectId?: ID;
  workCardId?: ID;
  permissions: ("read" | "watch" | "write" | "send")[];
  expiresAt?: ISOTime;
  grantedAt: ISOTime;
  revokedAt?: ISOTime;
}

/* ---------- 项目与前提 ---------- */

export interface Project {
  id: ID;
  name: string;
  goal: string;
  /** 项目级共享前提；多张工作卡的决策会引用同一个前提 */
  premiseIds: ID[];
  workCardIds: ID[];
  createdAt: ISOTime;
}

export interface Premise {
  id: ID;
  /** 如"Q4 预算" */
  label: string;
  /** 如"50 万" */
  value: string;
  /** 用户确认过的才是事实；未确认的在界面上标记 */
  confirmed: boolean;
  evidenceIds: ID[];
  /** 历史取值，用于时间线和"原 50 万"这类显示 */
  history: { value: string; evidenceIds: ID[]; at: ISOTime }[];
  projectId?: ID;
  /** 由 Agent 推断、自动生效但用户还没看过的值：界面标"推断"，用户确认或纠正后清除 */
  inferred?: { proposalId: ID; reason: string };
}

/* ---------- 决策与动作（H2：Decision Record） ---------- */

export type DecisionStatus = "valid" | "weakened" | "invalidated" | "superseded";
/** 决定前提变化后 Agent 怎么处理：自动改 / 暂停 / 让用户决定 / 起草补救 */
export type ReversalCost = "none" | "low" | "high" | "irreversible";

export interface Decision {
  id: ID;
  workCardId: ID;
  /** 如"主推方案 A" */
  statement: string;
  premiseIds: ID[];
  /** 依赖这个决策的其他决策和动作 */
  dependentDecisionIds: ID[];
  derivedActionIds: ID[];
  status: DecisionStatus;
  reversalCost: ReversalCost;
  confidence: "low" | "medium" | "high";
  /** 谁确认的、基于哪些证据 */
  provenance: { confirmedBy: "user" | "agent"; evidenceIds: ID[]; at: ISOTime };
  /** 失效时 LLM 给出的替代建议与代价 */
  suggestion?: { statement: string; tradeoff: string };
  supersededBy?: ID;
}

export type ActionStatus = "planned" | "paused" | "running" | "done" | "cancelled";

export interface Action {
  id: ID;
  workCardId: ID;
  label: string;
  status: ActionStatus;
  /** 已执行且对外生效的动作无法撤回，只能起草补救动作 */
  external: boolean;
  reversible: boolean;
  dependsOnDecisionIds: ID[];
  compensationFor?: ID;
  /** 结果直接由前提计算得出（如"按预算重算成本表"），前提变化时可自动重算 */
  premiseIds?: ID[];
  /** 需要哪个授权才能执行 */
  grantId?: ID;
  /** Agent 做出的产出（起草的文档、消息正文等），用户可查看 */
  output?: { kind: "document" | "message" | "note"; title: string; body: string; to?: string };
  /** 产出因前提变化被重算前的版本（最近的在后） */
  outputHistory?: { body: string; reason: string; at: ISOTime }[];
  doneAt?: ISOTime;
  /** 对外消息草稿经用户确认、可以发送的时间（本原型不代发） */
  approvedAt?: ISOTime;
}

/* ---------- 工作卡 ---------- */

export type WorkCardStage = "candidate" | "draft" | "active" | "done" | "parked";

export interface OpenQuestion {
  id: ID;
  question: string;
  /** 至少两个选项，草稿卡上直接点选 */
  options: string[];
  answer?: string;
  /** 回答后更新哪个前提 */
  premiseId?: ID;
}

/** 执行前放进对话框、等用户确认的计划 */
export interface ExecutionPlan {
  id: ID;
  steps: string[];
  /** 执行需要的授权，用人话描述，如"读取「对齐材料」文件夹 · 仅本任务 · 不对外发送" */
  scopeLabel?: string;
  grantIds: ID[];
  status: "proposed" | "confirmed" | "discarded";
  /** 计划拟好后前提又变了：记录变化、修订前的步骤；stale 表示还没能重拟 */
  revision?: { changes: { premiseId: ID; label: string; from: string; to: string }[]; previousSteps: string[]; stale?: boolean; at: ISOTime };
  createdAt: ISOTime;
}

export interface Reminder {
  id: ID;
  at: ISOTime;
  /** 提醒时机由任务性质推出，理由要能展示给用户 */
  reason: string;
  kind: "deadline" | "waiting_on_others" | "pending_decision" | "open_loop";
  /** 依赖的前提变化时重新计算 */
  premiseIds: ID[];
}

export interface WorkCard {
  id: ID;
  projectId?: ID;
  stage: WorkCardStage;
  title: string;
  goal?: string;
  status?: string;
  nextStep?: string;
  waitingOn?: string;
  decisionIds: ID[];
  actionIds: ID[];
  premiseIds: ID[];
  openQuestions: OpenQuestion[];
  plan?: ExecutionPlan;
  reminders: Reminder[];
  /** 候选阶段建议归入的项目（用户确认后才真正归入） */
  suggestedProject?: { projectId: ID; why: string };
  /** 候选卡的依据，如"你刚才说的" */
  originEvidenceIds: ID[];
  createdAt: ISOTime;
  updatedAt: ISOTime;
}

/* ---------- 涟漪：前提变化的影响 ---------- */

export interface ImpactItem {
  kind: "decision" | "action" | "reminder";
  id: ID;
  workCardId: ID;
  /** 按撤回成本分级后的处理方式 */
  handling: "needs_user" | "paused" | "auto_updated" | "compensate" | "unaffected";
}

/** LLM（或规则）对"某条决策在新前提下是否仍成立"的判断 */
export interface DecisionAssessment {
  decisionId: ID;
  verdict: "still_valid" | "weakened" | "invalidated";
  reason: string;
  suggestion?: { statement: string; tradeoff: string };
}

export interface PremiseChange {
  id: ID;
  premiseId: ID;
  from: string;
  to: string;
  evidenceId: ID;
  impacts: ImpactItem[];
  assessments: DecisionAssessment[];
  detectedAt: ISOTime;
  resolvedAt?: ISOTime;
}

/* ---------- 事件日志 ---------- */

export type EventType =
  | "card_created" | "card_stage_changed" | "question_answered"
  | "plan_proposed" | "plan_confirmed"
  | "decision_made" | "decision_status_changed"
  | "action_status_changed" | "external_action_executed"
  | "evidence_observed" | "premise_changed"
  | "grant_given" | "grant_revoked"
  | "rolled_back" | "exported" | "imported" | "model_switched";

export interface Event {
  id: ID;
  type: EventType;
  at: ISOTime;
  actor: "user" | "agent" | "watcher";
  /** 时间线只显示关键事件；Agent 的重试纠错标记为 false */
  visibleInTimeline: boolean;
  summary: string;
  payload: Record<string, unknown>;
  workCardId?: ID;
  projectId?: ID;
}

/* ---------- 可导出、可续接的完整状态 ---------- */

/** 与云朵小管家的对话，按范围（工作卡 / 项目 / 首页）分开保存 */
export interface ChatEntry {
  role: "user" | "agent";
  text: string;
  at: ISOTime;
  /** 这条消息附带的变更提议（界面在消息下展示前后对比和确认按钮） */
  proposalIds?: ID[];
  /** 用户引用的原文 */
  quote?: string;
}

/* ---------- 变更提议：所有前提变化的统一入口 ---------- */

/**
 * 不论变化来自用户明说、新材料还是 Agent 推断，都先成为一条提议；
 * harness 预演影响后按"把握 × 影响"分档：
 *   auto — 直接生效并告诉用户（用户明说的；或把握高且不碰已确认决定/已对外发出的东西）
 *   ask  — 先问一句，用户确认后生效
 * 把握低的推断不生成提议。
 */
export type ProposalSource = "user" | "material" | "inference";

export interface Proposal {
  id: ID;
  workCardId?: ID;
  source: ProposalSource;
  evidenceId: ID;
  /** 一句话理由，如"你说面试推迟到周六，作业截止通常跟着走" */
  reason: string;
  confidence: "low" | "medium" | "high";
  change: { premiseId: ID; label: string; from: string; to: string };
  mode: "auto" | "ask";
  /** 为什么要先问：会推翻你确认过的决定 / 会碰到已经对外发出的东西 / 把握不够高 */
  gateReason?: string;
  status: "applied" | "pending" | "confirmed" | "dismissed" | "corrected";
  /** 预演时得到的判断，确认时复用，不再调用模型 */
  assessments: DecisionAssessment[];
  /** 碰到已对外发出的东西时，预先起草的补救消息 */
  drafts: { forActionId: ID; to: string; title: string; body: string; actionId?: ID }[];
  premiseChangeId?: ID;
  createdAt: ISOTime;
  decidedAt?: ISOTime;
}

export interface AgentState {
  version: 1;
  chats?: Record<string, ChatEntry[]>;
  proposals?: Record<ID, Proposal>;
  projects: Record<ID, Project>;
  workCards: Record<ID, WorkCard>;
  premises: Record<ID, Premise>;
  decisions: Record<ID, Decision>;
  actions: Record<ID, Action>;
  evidence: Record<ID, Evidence>;
  grants: Record<ID, Grant>;
  premiseChanges: Record<ID, PremiseChange>;
  events: Event[];
  /** 当前使用的模型，切换后记录事件，状态本身不依赖模型 */
  model: { provider: string; name: string };
}
