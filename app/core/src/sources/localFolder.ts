import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { basename, join, relative } from "node:path";
import type { Evidence, Grant, SourceAdapter } from "../types.ts";
import { newId, now } from "../engine/ids.ts";

const TEXT_EXT = /\.(csv|txt|md|json)$/i;
const MAX_EXCERPT = 1200;

/**
 * 本地文件夹来源：只读授权目录（Grant.filter.dir），不递归到目录外。
 * 同一路径内容变化 → 新 Evidence，supersedes 指向旧版本；
 * 同名不同版本（预算表-v2 / v3）也会被识别为同一份材料的新版本。
 */
export class LocalFolderSource implements SourceAdapter {
  readonly kind = "local_folder" as const;
  /** ref → { hash, evidenceId } */
  private seen = new Map<string, { hash: string; evidenceId: string }>();

  constructor(private readonly rootForRefs: string, known: Evidence[] = []) {
    for (const e of known) this.seen.set(e.ref, { hash: "", evidenceId: e.id });
  }

  private dirOf(scope: Grant): string {
    const dir = scope.filter.dir;
    if (typeof dir !== "string") throw new Error(`授权 ${scope.id} 没有目录范围`);
    if (scope.revokedAt) throw new Error(`授权 ${scope.id} 已撤销`);
    if (!scope.permissions.includes("read")) throw new Error(`授权 ${scope.id} 不含读取权限`);
    return dir;
  }

  private async toEvidence(file: string): Promise<Evidence | null> {
    if (!TEXT_EXT.test(file)) return null;
    const content = await readFile(file, "utf8");
    const hash = createHash("sha256").update(content).digest("hex");
    const ref = relative(this.rootForRefs, file);
    const prev = this.seen.get(ref) ?? this.sameDocPrevious(ref);
    if (prev && prev.hash === hash) return null;
    const ev: Evidence = {
      id: newId("evd"), source: "local_folder", ref, title: basename(file),
      excerpt: content.slice(0, MAX_EXCERPT), observedAt: now(), supersedes: prev?.evidenceId,
    };
    this.seen.set(ref, { hash, evidenceId: ev.id });
    return ev;
  }

  /** 预算表-v3.csv 视为 预算表-v2.csv 的新版本 */
  private sameDocPrevious(ref: string) {
    const stem = (r: string) => r.replace(/[-_ ]?v\d+(?=\.\w+$)/i, "");
    let latest: { hash: string; evidenceId: string } | undefined;
    for (const [r, v] of this.seen) if (r !== ref && stem(r) === stem(ref)) latest = v;
    return latest;
  }

  /** 首次读取：把已知文件登记为基线（有内容哈希），返回新出现的证据 */
  async read(scope: Grant): Promise<Evidence[]> {
    const dir = this.dirOf(scope);
    const out: Evidence[] = [];
    for (const name of (await readdir(dir)).sort()) {
      const f = join(dir, name);
      if (!(await stat(f)).isFile()) continue;
      const ref = relative(this.rootForRefs, f);
      const known = this.seen.get(ref);
      if (known && !known.hash) {
        // 已在状态里的证据：只补哈希，不重复产出
        const c = await readFile(f, "utf8");
        known.hash = createHash("sha256").update(c).digest("hex");
        continue;
      }
      const ev = await this.toEvidence(f);
      if (ev) out.push(ev);
    }
    return out;
  }

  watch(scope: Grant, onEvidence: (e: Evidence) => void): () => void {
    if (!scope.permissions.includes("watch")) throw new Error(`授权 ${scope.id} 不含监听权限`);
    const dir = this.dirOf(scope);
    const timers = new Map<string, NodeJS.Timeout>();
    const w = watch(dir, (_evt, name) => {
      if (!name || name.startsWith(".")) return;
      const f = join(dir, name.toString());
      clearTimeout(timers.get(f));
      // 防抖：拖入/保存文件会触发多次事件
      timers.set(f, setTimeout(async () => {
        try {
          if (!(await stat(f)).isFile()) return;
          const ev = await this.toEvidence(f);
          if (ev) onEvidence(ev);
        } catch { /* 文件被删除或暂不可读，忽略 */ }
      }, 400));
    });
    return () => { w.close(); for (const t of timers.values()) clearTimeout(t); };
  }
}
