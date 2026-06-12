import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useTheme } from "../theme/ThemeContext";

type DialogEntry = { node: React.ReactNode; onClose?: () => void };

export type DialogApi = {
  push: (node: React.ReactNode, onClose?: () => void) => void;
  /** Close the whole stack and push a new entry (for mutually exclusive dialogs like command palette). */
  replace: (node: React.ReactNode, onClose?: () => void) => void;
  close: () => void;
  closeAll: () => void;
  isOpen: boolean;
};

const DialogContext = createContext<DialogApi>({
  push: () => undefined,
  replace: () => undefined,
  close: () => undefined,
  closeAll: () => undefined,
  isOpen: false,
});

export function useDialog(): DialogApi {
  return useContext(DialogContext);
}

export function DialogProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactNode {
  const [stack, setStack] = useState<DialogEntry[]>([]);
  // Ref for stack length to avoid stale closure in useKeyboard handler
  const stackLenRef = useRef(0);
  stackLenRef.current = stack.length;
  const { theme } = useTheme();
  const { width, height } = useTerminalDimensions();

  const push = useCallback(
    (node: React.ReactNode, onClose?: () => void) => {
      setStack((prev) => [...prev, { node, onClose }]);
    },
    [],
  );

  const replace = useCallback(
    (node: React.ReactNode, onClose?: () => void) => {
      setStack((prev) => {
        // Call onClose for all existing entries being removed
        for (const entry of prev) {
          entry.onClose?.();
        }
        return [{ node, onClose }];
      });
    },
    [],
  );

  const close = useCallback(() => {
    setStack((prev) => {
      if (prev.length === 0) return prev;
      const top = prev[prev.length - 1]!;
      top.onClose?.();
      return prev.slice(0, -1);
    });
  }, []);

  const closeAll = useCallback(() => {
    setStack((prev) => {
      for (const entry of prev) {
        entry.onClose?.();
      }
      return [];
    });
  }, []);

  // Fallback ESC handler — only consume when stack is non-empty.
  // Uses a ref to avoid stale closure (stack.length captured at registration time).
  useKeyboard((key) => {
    if (key.name === "escape" && stackLenRef.current > 0) {
      close();
    }
  });

  const isOpen = stack.length > 0;
  const topEntry = stack.length > 0 ? (stack[stack.length - 1] ?? null) : null;

  // Compute dialog box dimensions
  const dialogWidth = Math.min(64, Math.max(40, Math.floor(width * 0.6)));
  const dialogTop = Math.max(1, Math.floor(height / 4));
  const dialogLeft = Math.floor((width - dialogWidth) / 2);

  const api = useMemo<DialogApi>(
    () => ({ push, replace, close, closeAll, isOpen }),
    [push, replace, close, closeAll, isOpen],
  );

  return (
    <DialogContext.Provider value={api}>
      {children}
      {topEntry !== null && (
        <box
          position="absolute"
          top={dialogTop}
          left={dialogLeft}
          width={dialogWidth}
          zIndex={100}
          border={true}
          borderColor={theme.colors.accent}
          backgroundColor={theme.colors.backgroundPanel}
          padding={1}
          flexDirection="column"
        >
          {topEntry.node}
        </box>
      )}
    </DialogContext.Provider>
  );
}
