export function hello(name: string = "World"): string {
    return `Hello, ${name}!`;
}

// 直接运行本文件时打印（node src/hello_world.ts）
if (import.meta.url === `file://${process.argv[1]}`) {
    console.log(hello());
    console.log(hello("TypeScript"));
}
