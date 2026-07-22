import { spawn } from "node:child_process";
import { platform } from "node:os";

type SelectionRenderer = {
  clearSelection: () => void;
  copyToClipboardOSC52: (text: string) => boolean;
  getSelection: () => { getSelectedText: () => string } | null;
};

type Toast = (message: string, level?: "info" | "error") => void;
type ClipboardWriter = (text: string) => Promise<void>;

function writeProcess(command: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}`));
    });

    child.stdin.end(text);
  });
}

async function tryClipboardCommands(
  candidates: Array<{ command: string; args: string[] }>,
  text: string,
): Promise<void> {
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      await writeProcess(candidate.command, candidate.args, text);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("No clipboard command available");
}

export async function writeTextToClipboard(text: string): Promise<void> {
  const os = platform();

  if (os === "win32") {
    await writeProcess(
      "powershell.exe",
      [
        "-NonInteractive",
        "-NoProfile",
        "-Command",
        "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
      ],
      text,
    );
    return;
  }

  if (os === "darwin") {
    await writeProcess("pbcopy", [], text);
    return;
  }

  if (os === "linux") {
    await tryClipboardCommands(
      [
        ...(process.env.WAYLAND_DISPLAY
          ? [{ command: "wl-copy", args: [] }]
          : []),
        { command: "xclip", args: ["-selection", "clipboard"] },
        { command: "xsel", args: ["--clipboard", "--input"] },
      ],
      text,
    );
    return;
  }

  throw new Error(`Unsupported clipboard platform: ${os}`);
}

export function copySelectionToClipboard(
  renderer: SelectionRenderer,
  toast: Toast,
  writeClipboard: ClipboardWriter = writeTextToClipboard,
): boolean {
  const selection = renderer.getSelection();
  if (!selection) return false;

  const text = selection.getSelectedText();
  if (!text) {
    renderer.clearSelection();
    return true;
  }

  const osc52Accepted = renderer.copyToClipboardOSC52(text);
  void writeClipboard(text)
    .then(() => toast("Copied to clipboard"))
    .catch(() => {
      if (osc52Accepted) {
        toast("Copied to clipboard");
        return;
      }
      toast("Failed to copy selection", "error");
    });

  renderer.clearSelection();
  return true;
}
