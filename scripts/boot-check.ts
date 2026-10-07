/** 启动诊断：逐个加载依赖并计时，找出卡住的一步。 npm run boot:check */
const steps: [string, () => Promise<unknown>][] = [
  ["读取 .env", () => import("./env.ts")],
  ["加载 typebox", () => import("typebox")],
  ["加载 Pi 模型库 (@mariozechner/pi-ai)", () => import("@mariozechner/pi-ai")],
  ["加载 Pi Agent (@mariozechner/pi-agent-core)", () => import("@mariozechner/pi-agent-core")],
  ["加载核心代码", () => import("../app/core/src/index.ts")],
  ["加载服务器代码", () => import("../app/server/workspace.ts")],
];
for (const [name, load] of steps) {
  process.stdout.write(`${name} … `);
  const t = Date.now();
  const slow = setTimeout(() => process.stdout.write("（超过 10 秒，还在加载）"), 10000);
  await load();
  clearTimeout(slow);
  console.log(`${Date.now() - t}ms`);
}
console.log("全部加载完成。");
process.exit(0);
