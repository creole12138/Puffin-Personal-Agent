import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentState } from "../types.ts";

export function emptyState(model = { provider: "openai", name: "gpt-6-sol" }): AgentState {
  return {
    version: 1,
    projects: {}, workCards: {}, premises: {}, decisions: {}, actions: {},
    evidence: {}, grants: {}, premiseChanges: {}, events: [], model,
  };
}

/** 单文件 JSON 状态；原子写入（先写临时文件再 rename），避免半写入 */
export class FileStore {
  constructor(readonly path: string) {}

  async load(): Promise<AgentState | null> {
    try {
      const s = JSON.parse(await readFile(this.path, "utf8")) as AgentState;
      if (s.version !== 1) throw new Error(`不支持的状态版本 ${s.version}`);
      return s;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async save(state: AgentState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, this.path);
  }
}

export const clone = <T>(x: T): T => structuredClone(x);
