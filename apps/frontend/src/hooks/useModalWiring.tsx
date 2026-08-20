import { useEffect, useRef } from "react";
import { DialogSelect } from "../ui/DialogSelect";
import { DialogText } from "../ui/DialogText";
import { PermissionDialog } from "../components/dialogs/PermissionDialog";
import { QuestionDialog } from "../components/dialogs/QuestionDialog";
import type { useDialog } from "../ui/DialogContext";
import type { TuiSessionController } from "./sessionController";

type Session = TuiSessionController;
type Dialog = ReturnType<typeof useDialog>;

/**
 * 把后端发来的 modal / select 请求接到 Dialog 栈上。
 *
 * - permission：渲染 PermissionDialog；ESC 兜底按拒绝回应（否则后端挂起）。
 * - question：渲染 QuestionDialog；ESC 兜底回空串（否则后端 questionRequests 永久挂起）。
 * - select：空选项直接丢弃；否则渲染 DialogSelect，选中后提交 `${submitPrefix}${value}`。
 */
export function useModalWiring(session: Session, dialog: Dialog): void {
  // ── Dialog wiring for modal (permission / question) ─────────────────────────
  useEffect(() => {
    const modal = session.modal;
    if (!modal) return;

    if (modal.kind === "permission") {
      const requestId = modal.request_id;
      if (typeof requestId !== "string" || !requestId) return;
      const respondedRef = { current: false };

      const sendResponse = (allowed: boolean, scope: "once" | "session"): void => {
        if (respondedRef.current) return;
        respondedRef.current = true;
        session.sendRequest({
          type: "permission_response",
          request_id: requestId,
          allowed,
          scope,
        });
        session.setModal(null);
        dialog.close();
      };

      const onClose = (): void => {
        // ESC fallback: deny if not already responded
        if (!respondedRef.current) {
          respondedRef.current = true;
          session.sendRequest({
            type: "permission_response",
            request_id: requestId,
            allowed: false,
            scope: "once",
          });
          session.setModal(null);
        }
      };

      dialog.replace(
        <PermissionDialog modal={modal} onRespond={sendResponse} />,
        onClose,
      );
      return;
    }

    if (modal.kind === "question") {
      const requestId = modal.request_id;
      if (typeof requestId !== "string" || !requestId) return;
      const respondedRef = { current: false };

      const sendAnswer = (answer: string): void => {
        if (respondedRef.current) return;
        respondedRef.current = true;
        session.sendRequest({
          type: "question_response",
          request_id: requestId,
          answer,
        });
        session.setModal(null);
      };

      const onClose = (): void => {
        // esc 兜底：必须应答，否则后端 questionRequests 永久挂起。
        sendAnswer("");
      };

      dialog.replace(
        <QuestionDialog
          modal={modal}
          onSubmit={(answer) => {
            sendAnswer(answer);
            dialog.close();
          }}
        />,
        onClose,
      );
    }
  }, [session.modal]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const req = session.displayRequest;
    if (!req) return;

    dialog.replace(
      <DialogText title={req.title} content={req.content} />,
      () => session.setDisplayRequest(null),
    );
  }, [session.displayRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Dialog wiring for selectRequest ─────────────────────────────────────────
  // replace() 会触发旧弹层 onClose；ctrl+d 删会话只是更新 options，必须用 update()
  // 热刷新，否则 selectRequest 会被清掉，列表看起来没变。
  const selectOpenRef = useRef(false);
  useEffect(() => {
    const req = session.selectRequest;
    if (!req) {
      if (selectOpenRef.current) {
        selectOpenRef.current = false;
        dialog.close();
      }
      return;
    }

    const isSessions = req.submitPrefix === "/sessions open ";
    const node = (
      <DialogSelect
        title={req.title}
        items={req.options.map((opt) => ({
          value: opt.value,
          label: opt.label ?? opt.value,
          description: opt.description,
        }))}
        onSelect={(value) => {
          selectOpenRef.current = false;
          session.sendRequest({
            type: "submit_line",
            line: `${req.submitPrefix}${value}`,
          });
          session.setSelectRequest(null);
          dialog.close();
        }}
        onDelete={isSessions ? (value) => {
          session.sendRequest({ type: "delete_session", session_id: value });
        } : undefined}
      />
    );

    if (selectOpenRef.current) {
      dialog.update(node);
      return;
    }

    selectOpenRef.current = true;
    dialog.replace(node, () => {
      selectOpenRef.current = false;
      session.setSelectRequest(null);
    });
  }, [session.selectRequest]); // eslint-disable-line react-hooks/exhaustive-deps
}
