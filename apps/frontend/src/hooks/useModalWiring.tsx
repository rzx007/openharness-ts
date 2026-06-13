import React, { useEffect } from "react";
import { DialogSelect } from "../ui/DialogSelect";
import { PermissionDialog } from "../components/dialogs/PermissionDialog";
import { QuestionDialog } from "../components/dialogs/QuestionDialog";
import type { useDialog } from "../ui/DialogContext";
import type { useBackendSession } from "./useBackendSession";

type Session = ReturnType<typeof useBackendSession>;
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

  // ── Dialog wiring for selectRequest ─────────────────────────────────────────
  useEffect(() => {
    const req = session.selectRequest;
    if (!req) return;

    // Discard empty options
    if (req.options.length === 0) {
      session.setSelectRequest(null);
      return;
    }

    dialog.replace(
      <DialogSelect
        title={req.title}
        items={req.options.map((opt) => ({
          value: opt.value,
          label: opt.label ?? opt.value,
          description: opt.description,
        }))}
        onSelect={(value) => {
          session.sendRequest({
            type: "submit_line",
            line: `${req.submitPrefix}${value}`,
          });
          session.setBusy(true);
          dialog.close();
          session.setSelectRequest(null);
        }}
      />,
      () => {
        session.setSelectRequest(null);
      },
    );
  }, [session.selectRequest]); // eslint-disable-line react-hooks/exhaustive-deps
}
