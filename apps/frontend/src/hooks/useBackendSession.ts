import { useState, useEffect } from "react";

interface BackendEvent {
  type: string;
  [key: string]: unknown;
}

export function useBackendSession(backendCommand?: string) {
  const [status, setStatus] = useState("disconnected");
  const [events, setEvents] = useState<BackendEvent[]>([]);

  useEffect(() => {
    if (!backendCommand) {
      setStatus("no-backend");
      return;
    }

    setStatus("connecting");

    // TODO: spawn backend process and communicate via JSON-lines protocol
  }, [backendCommand]);

  async function sendMessage(content: string) {
    if (!content.trim()) return;
    setEvents((prev) => [...prev, { type: "user_message", content }]);
    // TODO: send to backend
  }

  return { status, events, sendMessage };
}
