/**
 * 模型调用按实际次数计费：每次状态变更开一个计数上下文，真正发出请求时才 +1。
 * useLLM(n) 里的 n 只是这次操作的上限（防止 Agent 循环失控），不再预扣。
 * 缓存命中（示例回放）不走真实请求，不计数。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface Usage { calls: number; cap: number }
export const usage = new AsyncLocalStorage<Usage>();

export class CapError extends Error {}

/** 每次真实请求前调用 */
export function countCall() {
  const u = usage.getStore();
  if (!u) return;
  if (u.calls >= u.cap) throw new CapError(`这一步调用模型的次数超过上限（${u.cap} 次），先停下了`);
  u.calls++;
}
