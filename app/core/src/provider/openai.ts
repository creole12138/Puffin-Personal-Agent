import {
  ProviderError,
  type LLMProvider,
  type ProviderConfig,
  type StructuredRequest,
  type StructuredResponse,
  type TextRequest,
  type TextResponse,
} from "./types.ts";

const OPTIONAL_PARAMS = new Set(["temperature", "top_p"]);

function safeParam(text: string): string | undefined {
  try {
    const e = (JSON.parse(text) as { error?: { param?: string; code?: string } }).error;
    return e?.code === "unsupported_value" || e?.code === "unsupported_parameter" ? e.param : undefined;
  } catch {
    return undefined;
  }
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

interface ChatCompletion {
  choices: { message: { content: string | null; refusal?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** OpenAI adapter：Chat Completions + json_schema 结构化输出，只用 fetch，无 SDK 依赖 */
export class OpenAIProvider implements LLMProvider {
  readonly id = "openai" as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(cfg: ProviderConfig) {
    if (!cfg.apiKey) throw new ProviderError("缺少 OPENAI_API_KEY", "openai");
    this.model = cfg.model;
    this.apiKey = cfg.apiKey;
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  /** 模型不支持的可选参数（如部分推理模型只接受默认 temperature），首次被拒后记住并自动去掉 */
  private readonly unsupportedParams = new Set<string>();

  private async call(body: Record<string, unknown>, signal?: AbortSignal): Promise<ChatCompletion> {
    for (const p of this.unsupportedParams) delete body[p];
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, ...body }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 400) {
        const param = safeParam(text);
        if (param && OPTIONAL_PARAMS.has(param) && param in body) {
          this.unsupportedParams.add(param);
          return this.call(body, signal);
        }
      }
      throw new ProviderError(
        `OpenAI ${res.status}: ${text.slice(0, 500)}`,
        "openai",
        res.status,
        res.status === 429 || res.status >= 500,
      );
    }
    return (await res.json()) as ChatCompletion;
  }

  async generateStructured<T>(req: StructuredRequest): Promise<StructuredResponse<T>> {
    const t0 = Date.now();
    const json = await this.call(
      {
        messages: req.messages,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        response_format: {
          type: "json_schema",
          json_schema: { name: req.task.replace(/[^a-zA-Z0-9_-]/g, "_"), strict: true, schema: req.schema },
        },
      },
      req.signal,
    );
    const msg = json.choices[0]?.message;
    if (msg?.refusal) throw new ProviderError(`模型拒绝：${msg.refusal}`, "openai");
    const raw = msg?.content ?? "";
    let data: T;
    try {
      data = JSON.parse(raw) as T;
    } catch {
      throw new ProviderError(`结构化输出不是合法 JSON：${raw.slice(0, 200)}`, "openai", undefined, true);
    }
    return {
      data,
      raw,
      provider: this.id,
      model: this.model,
      usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens },
      latencyMs: Date.now() - t0,
    };
  }

  async generateText(req: TextRequest): Promise<TextResponse> {
    const t0 = Date.now();
    const json = await this.call(
      { messages: req.messages, ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) },
      req.signal,
    );
    return {
      text: json.choices[0]?.message.content ?? "",
      provider: this.id,
      model: this.model,
      usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens },
      latencyMs: Date.now() - t0,
    };
  }
}
