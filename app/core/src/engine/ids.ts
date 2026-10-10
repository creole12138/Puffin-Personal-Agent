let counter = 0;
/** 可读、单调的 id：前缀 + 时间 + 序号 */
export function newId(prefix: string): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(3, "0")}`;
}
/** 新前提生效前的占位取值（见 newFact.ts）；文案据此显示为「新增」 */
export const NEW_PREMISE = "（原本没有）";
export const changeText = (label: string, from: string, to: string, verb = "变成了") => from === NEW_PREMISE ? `新增了「${label}」：${to}` : `${label}从 ${from} ${verb} ${to}`;
export const now = () => new Date().toISOString();
