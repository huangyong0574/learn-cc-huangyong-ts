// s01_agent_loop — Agent Loop
// 参考实现: ../../../learn-claude-code/s01_agent_loop/code.py
// 运行: node src/s01_agent_loop/code.ts

import type Anthropic from "@anthropic-ai/sdk";
import { client, MODEL } from "../shared/client.ts";
import { execSync } from "node:child_process";
import readline from "node:readline/promises";

const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`;

let history: Anthropic.MessageParam[] = [];

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

const TOOLS: Anthropic.Tool[] = [
    {
        name: "bash",
        description: "Run a shell command",
        input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
        },
    },
];

while (true) {
    let query: string;
    try {
        query = await rl.question("\x1b[36ms01 >> \x1b[0m");
    } catch {
        break; // readline 关闭(EOF / Ctrl+C)→ 优雅退出,对齐 Python 的 except EOFError
    }
    const q = query.trim().toLowerCase();
    if (q === "q" || q === "exit" || q === "") break;

    history.push({ role: "user", content: query });

    try {
        await agentLoop(history);
    } catch (e) {
        console.error(`\x1b[31m请求失败: ${(e as Error).message}\x1b[0m`);
    }
}
rl.close();

async function agentLoop(messages: Anthropic.MessageParam[]) {
    while (true) {
        const response = await client.messages.create({
            model: MODEL,
            system: SYSTEM,
            tools: TOOLS,
            max_tokens: 8000,
            messages: messages,
        });

        messages.push({ role: "assistant", content: response.content });

        if (response.stop_reason !== "tool_use") break;

        const result: Anthropic.ToolResultBlockParam[] = [];

        for (const block of response.content) {
            if (block.type === "tool_use") {
                const command = (block.input as { command?: string }).command ?? "";
                console.log(`\x1b[33m$ ${command}\x1b[0m`);
                const output = runBash(command);
                console.log(output.slice(0, 200));
                result.push({ type: "tool_result", tool_use_id: block.id, content: output });
            }
        }

        messages.push({ role: "user", content: result });
    }

    const last = messages.at(-1); // 最后一条消息
    if (last && Array.isArray(last.content)) {
        for (const block of last.content) {
            if (block.type === "text") {
                console.log(block.text);
            }
        }
    }
    console.log();
}

function runBash(command: string) {
    try {
        const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
        if (dangerous.some((d) => command.includes(d))) {
            return "Error: Dangerous command blocked";
        }
        const output = execSync(`${command} 2>&1`, { timeout: 120_000 });
        return output.toString().trim().slice(0, 50000) || "(no output)";
    } catch (e) {
        const err = e as Error & { killed?: boolean; stdout?: Buffer | string; stderr?: Buffer | string };

        // 超时:execSync 超时后会杀掉子进程(killed === true)
        if (err.killed) return "Error: Timeout (120s)";

        // 命令失败(退出码非 0 / 命令不存在):把实际输出拼出来回给模型,Agent 才能诊断
        const output = [err.stdout, err.stderr]
            .filter((v): v is Buffer | string => v != null)
            .map((v) => v.toString())
            .join("")
            .trim();
        return output || `Error: ${err.message}`;
    }
}

/*
定义本轮对话的列表history[]
等待用户输入的循环：
 接收用户提示词：
  获得用户prompt
 将用户的提示词加到history列表里
 While循环开始
    将history列表的内容输入给LLM
    将LLM的返回内容加到history
    判断LLM的返回状态是不是tool_use
    如果不是，直接停止循环。
    如果是，遍历所有返回块，挑出 type 为 tool_use 的，每个块执行一次工具，结果收集成数组，将数组加入到工具返回结果中，将所有工具返回结果加到history
    将新的history列表的内容再输入给大模型开启新一轮循环
 退出循环
    从 history 最后一条里挑出 type 为 text 的块，打印
关闭会话
*/
