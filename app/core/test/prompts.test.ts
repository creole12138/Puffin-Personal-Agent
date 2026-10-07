import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_SYSTEM_PROMPT, buildSystemPrompt } from "../src/harness/prompts.ts";

test("通用 System Prompt 不绑定具体案例，并包含关键行为规范", () => {
  assert.match(BASE_SYSTEM_PROMPT, /不确定/);
  assert.match(BASE_SYSTEM_PROMPT, /权限/);
  assert.match(BASE_SYSTEM_PROMPT, /不可逆/);
  assert.match(BASE_SYSTEM_PROMPT, /不得编造/);
  assert.doesNotMatch(BASE_SYSTEM_PROMPT, /预算|Q4|Alex/);
});

test("运行时上下文会注入项目状态和可用工具", () => {
  const prompt = buildSystemPrompt({
    projectId: "p_demo",
    workState: { goal: "准备项目汇报" },
    availableTools: [{ name: "read_material", label: "读取材料" }],
  });
  assert.match(prompt, /p_demo/);
  assert.match(prompt, /准备项目汇报/);
  assert.match(prompt, /read_material/);
  assert.match(prompt, /读取材料/);
});
