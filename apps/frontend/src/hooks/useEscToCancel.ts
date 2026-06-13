import { useEffect, useRef, useState } from "react";

/**
 * 双击 Esc 取消运行中的对话（对齐 opencode）。
 *
 * 第一次按 Esc 在 2s 内显示提示（escHint=true），期间再按 Esc 触发 onInterrupt；
 * 超时或对话结束（busy→false）自动复位。调用方在全局键盘处理里转发 Esc 到 handleEscape。
 *
 * @param busy 当前是否有运行中的对话
 * @param onInterrupt 第二次 Esc 时的中断回调（通常向后端发 interrupt 请求）
 */
export function useEscToCancel(busy: boolean, onInterrupt: () => void) {
  const [escHint, setEscHint] = useState(false);
  const escHintRef = useRef(false);
  const escTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 对话结束即复位，避免提示残留到下一轮。
  useEffect(() => {
    if (!busy) {
      if (escTimerRef.current) clearTimeout(escTimerRef.current);
      escTimerRef.current = null;
      escHintRef.current = false;
      setEscHint(false);
    }
  }, [busy]);

  const handleEscape = (): void => {
    if (escHintRef.current) {
      // 第二次 Esc — 中断
      if (escTimerRef.current) clearTimeout(escTimerRef.current);
      escTimerRef.current = null;
      escHintRef.current = false;
      setEscHint(false);
      onInterrupt();
    } else {
      // 第一次 Esc — 显示提示 2s
      escHintRef.current = true;
      setEscHint(true);
      escTimerRef.current = setTimeout(() => {
        escHintRef.current = false;
        setEscHint(false);
        escTimerRef.current = null;
      }, 2000);
    }
  };

  return { escHint, handleEscape };
}
