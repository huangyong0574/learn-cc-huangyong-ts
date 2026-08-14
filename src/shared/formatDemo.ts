export function greet(name: string) {
    const msg = `Hello, ${name}!`;
    return msg.toUpperCase();
}
export const nums = [1, 2, 3, 4, 5];
export function sum(list: number[]) {
    let total = 0;
    for (const n of list) {
        total += n;
    }
    return total;
}
