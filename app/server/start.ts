// 启动入口：先打印进度，再加载服务器（首次加载依赖可能需要一些时间）
console.log("正在启动云朵小管家…");
const t = Date.now();
const slow = setInterval(() => console.log(`仍在加载依赖（${Math.round((Date.now() - t) / 1000)} 秒）…`), 5000);
await import("./main.ts");
clearInterval(slow);
console.log(`加载完成，用时 ${((Date.now() - t) / 1000).toFixed(1)} 秒`);
