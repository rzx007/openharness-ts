export function parseJsonLines(input: string): unknown[] {
  return input
    .split("\n")
    .filter((line) => line.startsWith("OHJSON:"))
    .map((line) => JSON.parse(line.slice(7)));
}
