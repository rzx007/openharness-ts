export class ProtocolHost {
    /**
     * 异步生成器函数，用于监听标准输入流并解析特定格式的数据。
     * 该函数会逐行读取 stdin 的数据，筛选出以 "OHJSON:" 开头的行，
     * 去除前缀后将其解析为 JSON 对象，并作为泛型类型 T 产出。
     *
     * @template T - 期望解析出的数据类型，默认为 unknown。
     * @returns {AsyncIterable<T>} 一个异步可迭代对象，每次迭代产出一个解析后的 JSON 对象。
     */
    async *listen<T = unknown>(): AsyncIterable<T> {
      // 遍历标准输入流中的数据块
      for await (const chunk of process.stdin) {
        // 将数据块转换为字符串，按换行符分割，并过滤掉空行
        for (const line of chunk.toString().split("\n").filter(Boolean)) {
          // 检查行是否以特定协议前缀开头
          if (line.startsWith("OHJSON:")) {
            // 去除前缀并解析 JSON，然后产出结果
            yield JSON.parse(line.slice(7)) as T;
          }
        }
      }
    }

    /**
     * 将事件数据以 OHJSON 格式序列化并写入标准输出。
     * 
     * @param event - 需要 emitted 的事件数据，将被序列化为 JSON 字符串。
     * @returns 当数据成功写入标准输出后解析的 Promise。
     */
    async emit(event: unknown): Promise<void> {
      // 构造符合 OHJSON 协议格式的输出字符串
      const line = `OHJSON:${JSON.stringify(event)}\n`;
      process.stdout.write(line);
    }
}
