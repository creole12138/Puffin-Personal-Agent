let counter = 0;
/** 可读、单调的 id：前缀 + 时间 + 序号 */
export function newId(prefix: string): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(3, "0")}`;
}
export const now = () => new Date().toISOString();
