import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTerminalDimensions } from "@opentui/react";
import { useTheme } from "../theme/ThemeContext";

export type ToastLevel = "info" | "error";

type ToastEntry = {
  id: number;
  message: string;
  level: ToastLevel;
};

export type ToastApi = {
  toast: (message: string, level?: ToastLevel, ttlMs?: number) => void;
};

const ToastContext = createContext<ToastApi>({
  toast: () => undefined,
});

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

const TOAST_WIDTH = 36;
const DEFAULT_TTL_MS = 3000;

let nextId = 0;

function ToastItem({
  entry,
  top,
  left,
  zIndex,
  onExpire,
  ttlMs,
}: {
  entry: ToastEntry;
  top: number;
  left: number;
  zIndex: number;
  onExpire: (id: number) => void;
  ttlMs: number;
}): React.ReactNode {
  const { theme } = useTheme();

  useEffect(() => {
    const timer = setTimeout(() => {
      onExpire(entry.id);
    }, ttlMs);
    return () => clearTimeout(timer);
  }, [entry.id, ttlMs, onExpire]);

  const borderColor =
    entry.level === "error" ? theme.colors.error : theme.colors.info;

  return (
    <box
      position="absolute"
      top={top}
      left={left}
      width={TOAST_WIDTH}
      zIndex={zIndex}
      border={true}
      borderColor={borderColor}
      backgroundColor={theme.colors.backgroundPanel}
      padding={1}
      flexDirection="column"
    >
      <text>{entry.message}</text>
    </box>
  );
}

type ToastWithTtl = ToastEntry & { ttlMs: number };

export function ToastProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactNode {
  const [toasts, setToasts] = useState<ToastWithTtl[]>([]);
  const { width } = useTerminalDimensions();

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, level: ToastLevel = "info", ttlMs = DEFAULT_TTL_MS) => {
      const id = nextId++;
      setToasts((prev) => [...prev, { id, message, level, ttlMs }]);
    },
    [],
  );

  const api = useMemo<ToastApi>(() => ({ toast }), [toast]);

  // Right-align toasts: left = width - TOAST_WIDTH - 1
  const toastLeft = Math.max(0, width - TOAST_WIDTH - 1);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toasts.map((entry, index) => (
        <ToastItem
          key={entry.id}
          entry={entry}
          top={1 + index * 4}
          left={toastLeft}
          zIndex={200 + index}
          onExpire={removeToast}
          ttlMs={entry.ttlMs}
        />
      ))}
    </ToastContext.Provider>
  );
}
