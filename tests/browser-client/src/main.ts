import {
  OpenHarnessClient,
  applyEvent,
  applySessionSnapshot,
  createInitialClientState,
  type SessionEventRecord,
  type SessionStateSnapshot,
} from "@openharness/client";

const client = new OpenHarnessClient({
  baseUrl: "https://daemon.example.test",
  fetch: async () => new Response(JSON.stringify({
    ok: true,
    startedAt: 1,
    uptimeMs: 1,
    sessionCount: 1,
    activeRunCount: 0,
    queuedRunCount: 0,
  }), {
    headers: { "content-type": "application/json" },
  }),
});

const snapshot: SessionStateSnapshot = {
  cursor: 0,
  session: {
    id: "browser-session",
    cwd: "/workspace",
    title: "Browser fixture",
    model: "fixture-model",
    status: "idle",
    metadata: { runtime: { model: "fixture-model" } },
    createdAt: 1,
    updatedAt: 1,
  },
  inputs: [],
  messages: [],
  parts: [],
  runs: [],
  attempts: [],
  permissions: [],
};

const event: SessionEventRecord = {
  id: "event-1",
  seq: 1,
  type: "session.updated",
  schemaVersion: 1,
  sessionId: "browser-session",
  payload: { session: { ...snapshot.session, title: "Updated in browser" } },
  createdAt: 2,
};

let state = createInitialClientState();
state = applySessionSnapshot(state, snapshot);
state = applyEvent(state, event);
const health = await client.health();

document.querySelector("#result")!.textContent = JSON.stringify({
  serverOk: health.ok,
  title: state.sessions["browser-session"]?.title,
});
