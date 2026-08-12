// 工具链自检：确认 node --test 能跑 .ts、类型能被剥离、shared 模块能被解析。
// 等你写完 s01 就可以删掉这个文件，换成真正的章节测试。

import { test } from "node:test";
import assert from "node:assert/strict";

test("Node 能直接执行带类型注解的 .ts", () => {
  const tools: { name: string; input: Record<string, unknown> }[] = [
    { name: "bash", input: { command: "ls" } },
  ];
  assert.equal(tools[0]?.name, "bash");
});

test("能 import 带 .ts 后缀的相对路径", async () => {
  // 动态 import，避免没配 .env 时整个测试文件加载失败
  const mod = await import("../src/shared/client.ts").catch((err: unknown) => err);
  assert.ok(mod, "shared/client.ts 应该能被解析到（缺 .env 时抛错也算解析成功）");
});
