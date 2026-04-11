import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, extname } from "node:path";
import { readFile } from "node:fs/promises";

const execAsync = promisify(exec);

export interface LspServerConfig {
  command: string;
  args: string[];
  cwd?: string;
}

export interface SymbolInfo {
  name: string;
  kind: string;
  path: string;
  line: number;
  character: number;
  signature?: string;
  docstring?: string;
}

export interface HoverInfo {
  name: string;
  kind: string;
  path: string;
  line: number;
  character: number;
  signature?: string;
  docstring?: string;
}

export class LspClient {
  private config: LspServerConfig;
  private connected = false;

  constructor(config: LspServerConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async documentSymbols(filePath: string): Promise<SymbolInfo[]> {
    const content = await readFile(filePath, "utf-8").catch(() => "");
    if (!content) return [];
    return this.extractSymbols(content, filePath);
  }

  async workspaceSymbolSearch(root: string, query: string): Promise<SymbolInfo[]> {
    const ext = extname(root);
    if (!query) return [];
    try {
      const { stdout } = await execAsync(
        `rg --no-heading -n "${query.replace(/"/g, '\\"')}" --type-add 'source:*.{ts,js,py}' -t source -g "*.ts" -g "*.js" -g "*.py" --max-count 5`,
        { cwd: root, maxBuffer: 1024 * 1024 }
      );
      return stdout
        .split("\n")
        .filter(Boolean)
        .slice(0, 20)
        .map((line) => {
          const [file, lineStr, ...rest] = line.split(":");
          return {
            name: rest.join(":").trim().slice(0, 80),
            kind: "match",
            path: file ?? "",
            line: parseInt(lineStr ?? "0", 10),
            character: 0,
          };
        });
    } catch {
      return [];
    }
  }

  async hover(
    _root: string,
    _filePath: string,
    _symbol?: string,
    _line?: number,
    _character?: number
  ): Promise<HoverInfo | null> {
    return null;
  }

  async findReferences(
    root: string,
    filePath: string,
    symbol?: string,
    line?: number
  ): Promise<Array<{ path: string; line: number; text: string }>> {
    if (!symbol) return [];
    try {
      const { stdout } = await execAsync(
        `rg --no-heading -n "${symbol.replace(/"/g, '\\"')}" -g "*.ts" -g "*.js" -g "*.py" --max-count 20`,
        { cwd: root, maxBuffer: 1024 * 1024 }
      );
      return stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [file, lineStr, ...rest] = l.split(":");
          return { path: file ?? "", line: parseInt(lineStr ?? "0", 10), text: rest.join(":") };
        });
    } catch {
      return [];
    }
  }

  async goToDefinition(
    root: string,
    filePath: string,
    symbol?: string,
    line?: number
  ): Promise<SymbolInfo[]> {
    if (!symbol) return [];
    const refs = await this.findReferences(root, filePath, symbol, line);
    return refs.map((r) => ({
      name: symbol,
      kind: "definition",
      path: r.path,
      line: r.line,
      character: 0,
    }));
  }

  private extractSymbols(content: string, filePath: string): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];
    const patterns = [
      { regex: /^(export\s+)?(async\s+)?function\s+(\w+)/gm, kind: "function" },
      { regex: /^(export\s+)?(abstract\s+)?class\s+(\w+)/gm, kind: "class" },
      { regex: /^(export\s+)?(const|let|var)\s+(\w+)/gm, kind: "variable" },
      { regex: /^(export\s+)?interface\s+(\w+)/gm, kind: "interface" },
      { regex: /^(export\s+)?type\s+(\w+)/gm, kind: "type" },
      { regex: /^def\s+(\w+)/gm, kind: "function" },
      { regex: /^class\s+(\w+)/gm, kind: "class" },
    ];

    for (const { regex, kind } of patterns) {
      let match;
      while ((match = regex.exec(content)) !== null) {
        const name = match[match.length - 1];
        if (name) {
          const line = content.slice(0, match.index).split("\n").length;
          symbols.push({ name, kind, path: filePath, line, character: match.index });
        }
      }
    }
    return symbols;
  }
}
