import "./env.ts";
import { createProvider, providerConfigFromEnv } from "../app/core/src/index.ts";
const cfg = providerConfigFromEnv();
const p = createProvider(cfg);
console.log(`调用 ${p.id} / ${p.model} …`);
const r = await p.generateStructured<{ ok: boolean; echo: string }>({
  task: "ping",
  messages: [{ role: "user", content: "返回 ok=true，echo 为“你好”" }],
  schema: { type: "object", additionalProperties: false, required: ["ok", "echo"], properties: { ok: { type: "boolean" }, echo: { type: "string" } } },
});
console.log(r.data, `${r.latencyMs}ms`, r.usage);
