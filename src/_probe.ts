import { client, MODEL } from "./shared/client.ts";

const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1000,
    system: "You are a shell agent. Use the bash tool. Act, don't explain.",
    tools: [
        {
            name: "bash",
            description: "Run a shell command.",
            input_schema: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
            },
        },
    ],
    messages: [
        {
            role: "user",
            content: "分三条独立命令查看：当前目录、当前日期、node 版本。三件事互不依赖。",
        },
    ],
});

console.log("model       =", MODEL);
console.log("stop_reason =", res.stop_reason);
console.log("blocks      =", res.content.map((b) => b.type).join(", "));
console.log("tool_use 数 =", res.content.filter((b) => b.type === "tool_use").length);
for (const b of res.content) {
    if (b.type === "tool_use") console.log(`  [${b.id}] ${JSON.stringify(b.input)}`);
}
