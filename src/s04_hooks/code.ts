// s04_hooks — Hooks
// 参考实现: ../../../learn-claude-code/s04_hooks/code.py
// 运行: node src/s04_hooks/code.ts

import type Anthropic from "@anthropic-ai/sdk";
import { client, MODEL } from "../shared/client.ts";
import { execSync } from "node:child_process";
import readline from "node:readline/promises";
import { existsSync, globSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

// -- 常量/配置 --

const SYSTEM = `You are a coding agent at ${process.cwd()}. All destructive operations require user approval.`;

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
    {
        name: "read_file",
        description: "Read file contents.",
        input_schema: {
            type: "object",
            properties: {
                path: { type: "string" },
                limit: { type: "integer" },
            },
            required: ["path"],
        },
    },
    {
        name: "write_file",
        description: "Write content to a file",
        input_schema: {
            type: "object",
            properties: {
                path: { type: "string" },
                content: { type: "string" },
            },
            required: ["path", "content"],
        },
    },
    {
        name: "edit_file",
        description: "Replace exact text in a file once.",
        input_schema: {
            type: "object",
            properties: {
                path: { type: "string" },
                old_text: { type: "string" },
                new_text: { type: "string" },
            },
            required: ["path", "old_text", "new_text"],
        },
    },
    {
        name: "glob",
        description: "Find files matching a glob pattern.",
        input_schema: {
            type: "object",
            properties: {
                pattern: { type: "string" },
            },
            required: ["pattern"],
        },
    },
];

// Gate 1 数据：硬拒绝清单
const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"];

// Gate 2 数据：软约束规则表（每条规则 = 适用工具 + 判断函数 + 理由文案）
const PERMISSION_RULES = [
    {
        tools: ["read_file", "write_file", "edit_file"],
        check: (args: Record<string, unknown>) => {
            const p = (args.path as string) ?? "";
            const workdir = process.cwd();
            const resolved = path.resolve(workdir, p);
            const rel = path.relative(workdir, resolved);
            return rel.startsWith("..") || path.isAbsolute(rel);
        },
        message: "Writing outside workspace",
    },
    {
        tools: ["bash"],
        check: (args: Record<string, unknown>) =>
            ["rm ", "> /etc/", "chmod 777"].some((kw) => ((args.command as string) ?? "").includes(kw)),
        message: "Potentially destructive command",
    },
];


type HookEvent = "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";
type HookCallbackMap = {
    "UserPromptSubmit":(query:string) => (string | null);
}


// -- 类型定义 --

type ToolHandler = (input: Record<string, unknown>) => string;

// -- 权限三道门（检查层）--

//检查硬拒绝门禁
function checkDenyList(command: string): string | null {
    const hit = DENY_LIST.find((pattern) => command.includes(pattern));
    if (hit != null) {
        return `Blocked: '${hit}' is on the deny list`;
    }
    return null;
}

//检查软约束门禁，风险操作询问用户
function checkRule(toolName: string, args: Record<string, unknown>): string | null {
    for (const rule of PERMISSION_RULES) {
        if (rule.tools.includes(toolName) && rule.check(args)) {
            return rule.message;
        }
    }
    return null;
}

//询问用户函数
async function askUser(toolName: string, args: Record<string, unknown>, reason: string): Promise<string> {
    console.log(`\n\x1b[33m[permission] ${reason}\x1b[0m`);
    console.log(`   Tool: ${toolName}(${JSON.stringify(args)})`);
    const choice = (await rl.question("   Allow? [y/N] ")).trim().toLowerCase();
    return ["y", "yes"].includes(choice) ? "allow" : "deny";
}

async function checkPermisions(block: Anthropic.Messages.ToolUseBlock): Promise<boolean> {
    //如果AI返回的调用bash，那么判断bash的命令是否在硬拒绝列表里，如果是则直接将原因和结果返回给AgentLoop;如果不是，则检查是否是潜在风险操作
    //如果是潜在风险操作则调用向用户授权，如果用户授权返回yes或者其他拒绝则都讲原因和结果返回给Agentloop
    if (block.name === "bash") {
        const reason = checkDenyList(((block.input as Record<string, unknown>).command as string) ?? "");
        if (reason) {
            console.log(`\n\x1b[31m[blocked] ${reason}\x1b[0m`);
            return false;
        }
    }
    // Gate 2: 规则匹配
    const args = block.input as Record<string, unknown>;
    const reason = checkRule(block.name, args);
    if (reason) {
        // Gate 3: 询问用户
        const decision = await askUser(block.name, args, reason);
        if (decision === "deny") {
            return false;
        }
    }
    return true;
}

// -- 工具实现（执行层）--

/**
 * 路径沙箱：把任意输入路径解析为工作区内的绝对路径，逃逸即抛错。
 *
 * 两道检查，类比机场的两道安检：
 * 1. 验票（字符串层）：path.resolve + relative，拦 `../` 向上爬；
 * 2. 验证件（文件系统层）：realpathSync 解析符号链接，拦指向工作区外的“快捷方式”。
 *
 * 第二道对齐 Python Path.resolve(strict=False)：写入目标可能尚不存在，
 * 全路径 realpathSync 会抛 ENOENT，故只解析最近的存在祖先目录，再拼回缺失尾部复查。
 */
function safePath(p: string): string {
    const workdir = process.cwd();
    const resolved = path.resolve(workdir, p);
    const rel = path.relative(workdir, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`Path escapes workspace: ${p}`); // 逃逸就抛错
    }
    // 对齐 Python Path.resolve() 的 strict=False 语义:
    // 写入场景目标文件可能不存在,直接 realpathSync 会抛 ENOENT,
    // 所以向上找最近的存在祖先目录解析符号链接,再拼回缺失的尾部二次检查
    let existing = resolved;
    const missing: string[] = [];
    while (!existsSync(existing)) {
        missing.unshift(path.basename(existing));
        existing = path.dirname(existing);
    }
    const real = path.join(realpathSync(existing), ...missing);
    const realRel = path.relative(workdir, real);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
        throw new Error(`Path escapes workspace: ${p}`);
    }
    return real;
}

function runBash(command: string) {
    try {
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

function runRead(path: string, limit?: number) {
    try {
        const lines = readFileSync(safePath(path), "utf-8").split(/\r?\n/);
        if (limit !== undefined && limit < lines.length) {
            const remain = lines.length - limit;
            lines.length = limit;
            lines.push(`...(${remain} more lines)`);
        }
        return lines.join("\n");
    } catch (e) {
        return `Error: ${(e as Error).message}`;
    }
}

function runWrite(p: string, content: string) {
    try {
        const filePath = safePath(p);
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, content);
        return `Wrote ${content.length} bytes to ${p}`;
    } catch (e) {
        return `Error: ${(e as Error).message}`;
    }
}

function runEdit(path: string, oldText: string, newText: string) {
    try {
        const filePath = safePath(path);
        const file_content = readFileSync(filePath, "utf-8");
        if (!file_content.includes(oldText)) {
            return `Error: text not found in ${filePath}`;
        }
        writeFileSync(filePath, file_content.replace(oldText, newText));
        return `Edited ${filePath}`;
    } catch (e) {
        return (e as Error).message;
    }
}

function runGlob(pattern: string) {
    try {
        const workdir = process.cwd();
        const result = globSync(pattern, { cwd: workdir }).filter((match) => {
            const real = realpathSync(path.resolve(workdir, match));
            const rel = path.relative(workdir, real);
            return !rel.startsWith("..") && !path.isAbsolute(rel);
        });
        return result.join("\n") || "(no matches)";
    } catch (e) {
        return `${(e as Error).message}`;
    }
}

// -- 工具分发 --

const TOOL_HANDLERS: Record<string, ToolHandler> = {
    bash: (input) => runBash((input.command as string) ?? ""),
    read_file: (input) => runRead((input.path as string) ?? ""),
    write_file: (input) => runWrite((input.path as string) ?? "", (input.content as string) ?? ""),
    edit_file: (input) =>
        runEdit(
            (input.path as string) ?? "",
            (input.old_text as string) ?? "",
            (input.new_text as string) ?? "",
        ),
    glob: (input) => runGlob((input.pattern as string) ?? ""),
};

// -- Agent Loop --

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
                if (!(await checkPermisions(block))) {
                    result.push({
                        type: "tool_result",
                        tool_use_id: block.id,
                        content: "Permission denied.",
                    });
                    continue;
                }
                console.log(`\x1b[36m> ${block.name}\x1b[0m`);
                const handler = TOOL_HANDLERS[block.name];
                const output = handler
                    ? handler(block.input as Record<string, unknown>)
                    : `unknown:${block.name}`;
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

// -- 入口：主循环 --

let history: Anthropic.MessageParam[] = [];
// 新增两行
console.log("s03: Permission");
console.log("Enter a question, press Enter to send. Type q to quit.\n");

while (true) {
    let query: string;
    try {
        query = await rl.question("\x1b[36ms03 >> \x1b[0m");
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
