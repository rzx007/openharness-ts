export class ProtocolHost {
  async *listen<T = unknown>(): AsyncIterable<T> {
    for await (const chunk of process.stdin) {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        if (line.startsWith("OHJSON:")) {
          yield JSON.parse(line.slice(7)) as T;
        }
      }
    }
  }

  async emit(event: unknown): Promise<void> {
    const line = `OHJSON:${JSON.stringify(event)}\n`;
    process.stdout.write(line);
  }
}
