/**
 * Provider 抽象层（多 Provider 设计，第一阶段只实现 OpenAI）。
 *
 * 原则：Agent 的状态不依赖任何一个模型。Harness 只通过这个接口调用模型，
 * 每次调用都记录 provider/model，切换模型时写入 model_switched 事件，
 * 工作状态（AgentState）原样续接。
 */

export type ProviderId = "openai" | "kimi" | "anthropic";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** JSON Schema（子集），用于结构化输出 */
export type JSONSchema = Record<string, unknown>;

export interface StructuredRequest {
  /** 任务名，同时作为 schema 名，便于日志与回放 */
  task: string;
  messages: ChatMessage[];
  schema: JSONSchema;
  temperature?: number;
  signal?: AbortSignal;
}

export interface LLMUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface StructuredResponse<T> {
  data: T;
  provider: ProviderId;
  model: string;
  usage?: LLMUsage;
  /** 原始文本，写入回放缓存 */
  raw: string;
  latencyMs: number;
}

export interface TextRequest {
  task: string;
  messages: ChatMessage[];
  temperature?: number;
  signal?: AbortSignal;
}

export interface TextResponse {
  text: string;
  provider: ProviderId;
  model: string;
  usage?: LLMUsage;
  latencyMs: number;
}

export interface LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  /** 按 schema 返回结构化 JSON；实现方负责解析与基本校验 */
  generateStructured<T>(req: StructuredRequest): Promise<StructuredResponse<T>>;
  generateText(req: TextRequest): Promise<TextResponse>;
}

export interface ProviderConfig {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderId,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
