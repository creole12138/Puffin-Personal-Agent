import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LLMProvider, StructuredRequest, StructuredResponse, TextRequest, TextResponse } from "./types.ts";

/**
 * 回放包装：真实调用的结果按请求哈希存盘；LLM_MODE=replay 时只读缓存。
 * 用途：现场演示不受网络/模型波动影响，也便于测试。
 */
export class ReplayProvider implements LLMProvider {
  readonly id;
  readonly model;
  constructor(
    private readonly inner: LLMProvider | null,
    private readonly dir: string,
    private readonly mode: "live" | "record" | "replay" = "record",
    meta?: { id: LLMProvider["id"]; model: string },
  ) {
    this.id = inner?.id ?? meta?.id ?? "openai";
    this.model = inner?.model ?? meta?.model ?? "unknown";
  }

  private key(task: string, payload: unknown) {
    const h = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
    return join(this.dir, `${task}-${h}.json`);
  }

  private async cached<R>(task: string, payload: unknown, run: () => Promise<R>): Promise<R> {
    const file = this.key(task, payload);
    if (this.mode !== "live") {
      try {
        return JSON.parse(await readFile(file, "utf8")) as R;
      } catch {
        if (this.mode === "replay") throw new Error(`回放缓存缺失：${file}`);
      }
    }
    if (!this.inner) throw new Error("没有可用的 Provider");
    const out = await run();
    if (this.mode === "record") {
      await mkdir(this.dir, { recursive: true });
      await writeFile(file, JSON.stringify(out, null, 2));
    }
    return out;
  }

  generateStructured<T>(req: StructuredRequest): Promise<StructuredResponse<T>> {
    const { signal: _s, ...payload } = req;
    return this.cached(req.task, payload, () => this.inner!.generateStructured<T>(req));
  }
  generateText(req: TextRequest): Promise<TextResponse> {
    const { signal: _s, ...payload } = req;
    return this.cached(req.task, payload, () => this.inner!.generateText(req));
  }
}
