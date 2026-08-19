import { describe, expect, it } from "vitest"

import { reserveSubscriptionSnapshot, SessionSubscriptionRegistry } from "./session-subscriptions"

function subscription(sessionId: string): {
  controller: AbortController
  sessionId: string
} {
  return { controller: new AbortController(), sessionId }
}

describe("SessionSubscriptionRegistry", () => {
  it("keeps the primary subscription alive when an auxiliary subscription opens", () => {
    const registry = new SessionSubscriptionRegistry()
    const primary = subscription("parent")
    const child = subscription("child")

    registry.set(7, "primary", primary)
    registry.set(7, "child:details", child)

    expect(registry.get(7, "primary")).toBe(primary)
    expect(registry.get(7, "child:details")).toBe(child)
    expect(primary.controller.signal.aborted).toBe(false)
  })

  it("aborts only the previous subscription when the same slot is replaced", () => {
    const registry = new SessionSubscriptionRegistry()
    const primary = subscription("parent")
    const firstChild = subscription("child-one")
    const nextChild = subscription("child-two")

    registry.set(7, "primary", primary)
    registry.set(7, "child:details", firstChild)
    registry.set(7, "child:details", nextChild)

    expect(firstChild.controller.signal.aborted).toBe(true)
    expect(primary.controller.signal.aborted).toBe(false)
    expect(registry.get(7, "child:details")).toBe(nextChild)
  })

  it("aborts every subscription owned by a window when the primary session closes", () => {
    const registry = new SessionSubscriptionRegistry()
    const primary = subscription("parent")
    const child = subscription("child")

    registry.set(7, "primary", primary)
    registry.set(7, "child:details", child)
    registry.clearOwner(7)

    expect(primary.controller.signal.aborted).toBe(true)
    expect(child.controller.signal.aborted).toBe(true)
    expect(registry.get(7, "primary")).toBeUndefined()
    expect(registry.get(7, "child:details")).toBeUndefined()
  })

  it("closes one auxiliary slot without interrupting the primary subscription", () => {
    const registry = new SessionSubscriptionRegistry()
    const primary = subscription("parent")
    const child = subscription("child")

    registry.set(7, "primary", primary)
    registry.set(7, "child:details", child)

    expect(registry.delete(7, "child:details")).toBe(true)
    expect(child.controller.signal.aborted).toBe(true)
    expect(primary.controller.signal.aborted).toBe(false)
    expect(registry.get(7, "primary")).toBe(primary)
  })

  it("aborts subscriptions from every window during application shutdown", () => {
    const registry = new SessionSubscriptionRegistry()
    const first = subscription("first")
    const second = subscription("second")
    registry.set(7, "primary", first)
    registry.set(8, "primary", second)

    registry.clearAll()

    expect(first.controller.signal.aborted).toBe(true)
    expect(second.controller.signal.aborted).toBe(true)
    expect(registry.get(7, "primary")).toBeUndefined()
    expect(registry.get(8, "primary")).toBeUndefined()
  })

  it("keeps the newer subscription when snapshots resolve out of order", async () => {
    const registry = new SessionSubscriptionRegistry()
    const first = subscription("child-one")
    const second = subscription("child-two")
    const firstSnapshot = deferred<IteratorResult<string>>()
    const secondSnapshot = deferred<IteratorResult<string>>()

    const firstOpen = reserveSubscriptionSnapshot(
      registry,
      7,
      "child:details",
      first,
      () => iteratorFrom(firstSnapshot.promise),
      "empty"
    )
    const secondOpen = reserveSubscriptionSnapshot(
      registry,
      7,
      "child:details",
      second,
      () => iteratorFrom(secondSnapshot.promise),
      "empty"
    )
    secondSnapshot.resolve({ done: false, value: "second" })
    await expect(secondOpen).resolves.toMatchObject({ snapshot: "second" })
    firstSnapshot.resolve({ done: false, value: "first" })
    await expect(firstOpen).rejects.toThrow("订阅已被替换或关闭")

    expect(first.controller.signal.aborted).toBe(true)
    expect(second.controller.signal.aborted).toBe(false)
    expect(registry.get(7, "child:details")).toBe(second)
  })

  it.each(["delete", "clearOwner"] as const)(
    "does not revive a pending subscription after %s",
    async (closeMethod) => {
      const registry = new SessionSubscriptionRegistry()
      const pending = subscription("child")
      const snapshot = deferred<IteratorResult<string>>()
      const open = reserveSubscriptionSnapshot(
        registry,
        7,
        "child:details",
        pending,
        () => iteratorFrom(snapshot.promise),
        "empty"
      )

      if (closeMethod === "delete") registry.delete(7, "child:details")
      else registry.clearOwner(7)
      snapshot.resolve({ done: false, value: "late" })

      await expect(open).rejects.toThrow("订阅已被替换或关闭")
      expect(pending.controller.signal.aborted).toBe(true)
      expect(registry.get(7, "child:details")).toBeUndefined()
    }
  )

  it("does not install an iterator whose client setup finishes after close", async () => {
    const registry = new SessionSubscriptionRegistry()
    const pending = subscription("child")
    const iteratorSetup = deferred<AsyncIterator<string>>()
    const open = reserveSubscriptionSnapshot(
      registry,
      7,
      "child:details",
      pending,
      () => iteratorSetup.promise,
      "empty"
    )

    registry.clearOwner(7)
    iteratorSetup.resolve(iteratorFrom(Promise.resolve({ done: false, value: "late" })))

    await expect(open).rejects.toThrow("订阅已被替换或关闭")
    expect(registry.get(7, "child:details")).toBeUndefined()
  })
})

function iteratorFrom<T>(promise: Promise<IteratorResult<T>>): AsyncIterator<T> {
  return { next: () => promise }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
