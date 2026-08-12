// 全仓库唯一允许的跨章共享模块。
//
// 这里只放「重复 17 遍毫无学习价值」的样板：读 .env、建 client。
// 工具定义、权限、hooks、压缩……一律各章自己写一遍 —— 那些正是要内化的东西，
// 抽到这里就退化成「组装」而不是「重新想一遍」了。

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

// Node 25 原生支持读 .env，不需要 dotenv
const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少环境变量 ${name} —— 复制 .env.example 到 .env 并填好`);
  }
  return value;
}

const baseURL = process.env.ANTHROPIC_BASE_URL;

// 对齐 Python 原版：走第三方兼容端点时清掉 AUTH_TOKEN，避免 SDK 优先用它导致 401
if (baseURL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

export const MODEL = requireEnv("MODEL_ID");

export const client = new Anthropic({
  apiKey: requireEnv("ANTHROPIC_API_KEY"),
  ...(baseURL ? { baseURL } : {}),
});
