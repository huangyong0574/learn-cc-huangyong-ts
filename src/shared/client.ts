// 全仓库唯一允许的跨章共享模块。
//
// 这里只放「重复 17 遍毫无学习价值」的样板：读 .env、建 client。
// 工具定义、权限、hooks、压缩……一律各章自己写一遍 —— 那些正是要内化的东西，
// 抽到这里就退化成「组装」而不是「重新想一遍」了。
//
// 本仓库【只用 DeepSeek】。端点、模型、key 都在这个文件里定死，各章不再关心 provider。

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

// Node 25 原生支持读 .env，不需要 dotenv。
//
// 但 process.loadEnvFile() 【不覆盖】已存在的环境变量，而 Claude Code 之类的工具
// 会往 shell 里注入自己的一套变量。不处理的话，.env 里配的值会被静默忽略。
// 对齐 Python 原版的 load_dotenv(override=True)：先删掉 .env 声明过的同名变量，
// 再交给 Node 解析（键名自己扫，值的解析仍复用 Node，省得手写引号/转义）。
const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
        if (key) delete process.env[key];
    }
    process.loadEnvFile(envPath);
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`缺少环境变量 ${name} —— 复制 .env.example 到 .env 并填好`);
    }
    return value;
}

// DeepSeek 的 Anthropic 兼容端点。
//
// 为什么不换成 DeepSeek 的 OpenAI 兼容接口（/v1/chat/completions）：
// 这 17 章要内化的是 Anthropic Messages 协议的形状 —— messages[] 里 tool_use /
// tool_result 成对出现、stop_reason 驱动循环、system 是独立字段。换成 OpenAI 风格
// （tool_calls + role:"tool"、finish_reason）整个 harness 的骨架就变了，学的就不是
// Claude Code 了。所以 @anthropic-ai/sdk 保留 —— 它在这里是「协议客户端」，不是「厂商 SDK」。
//
// 写死不走环境变量：留 ANTHROPIC_BASE_URL 这个口子的唯一后果，是 shell 里那个被注入的
// https://api.anthropic.com 把 DeepSeek 的 key 打到 Anthropic 去 → 401，且报错毫无线索。
const BASE_URL = "https://api.deepseek.com/anthropic";

// 模型可以在 .env 里用 MODEL_ID 覆盖；不填就用这个默认值。
// 于是 .env 里【唯一必填的就是一个 key】。
// 默认取 flash 而不是 pro：这 17 章绝大多数时间在反复跑循环调试 harness 本身，
// 便宜快比聪明重要；真要看模型能力再临时改 MODEL_ID。
export const MODEL = process.env.MODEL_ID || "deepseek-v4-flash";

export const client = new Anthropic({
    apiKey: requireEnv("DEEPSEEK_API_KEY"),
    baseURL: BASE_URL,
    // authToken 不显式置 null 的话，SDK 会去读 shell 里的 ANTHROPIC_AUTH_TOKEN
    // （Claude Code 会注入），额外发一个 Authorization: Bearer 头。DeepSeek 认这个头，
    // 于是拿着 Anthropic 的 token 打过去，必 401。
    authToken: null,
});
