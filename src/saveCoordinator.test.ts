import { describe, expect, it, vi } from "vitest";
import { createSaveCoordinator } from "./saveCoordinator";

function makeGate(buffer: { text: string }, dirty = true) {
  const dirtyRef = { current: dirty };
  const onDirty = vi.fn();
  const gate = createSaveCoordinator(dirtyRef, () => buffer.text, onDirty);
  return { gate, dirtyRef, onDirty };
}

describe("begin", () => {
  it("starts a write only when dirty and idle", () => {
    const { gate, dirtyRef } = makeGate({ text: "A" }, false);
    expect(gate.begin()).toBe(false);
    dirtyRef.current = true;
    expect(gate.begin()).toBe(true);
    // A second request while in flight is coalesced, not started.
    expect(gate.begin()).toBe(false);
  });

  it("does not queue a follow-up for a clean coalesced request", () => {
    const { gate, dirtyRef } = makeGate({ text: "A" });
    gate.begin(); // write in flight
    dirtyRef.current = false; // edits undone while the write was running
    expect(gate.begin()).toBe(false); // coalesced, but nothing new to write
    expect(gate.takeFollowUp()).toBe(false);
  });
});

describe("complete", () => {
  it("clears dirty when the buffer still holds what was written", () => {
    const buffer = { text: "A" };
    const { gate, dirtyRef, onDirty } = makeGate(buffer);
    gate.begin();
    expect(gate.complete("A")).toBe(true);
    expect(dirtyRef.current).toBe(false);
    expect(onDirty).toHaveBeenCalledWith(false);
  });

  it("keeps dirty when edits landed during the write (the race)", () => {
    const buffer = { text: "A" };
    const { gate, dirtyRef, onDirty } = makeGate(buffer);
    gate.begin();
    buffer.text = "AB"; // typed while the write was in flight
    expect(gate.complete("A")).toBe(false);
    expect(dirtyRef.current).toBe(true);
    expect(onDirty).not.toHaveBeenCalled();
  });

  it("treats undo-back-to-saved-content as clean", () => {
    const buffer = { text: "A" };
    const { gate, dirtyRef } = makeGate(buffer);
    gate.begin();
    buffer.text = "AB";
    buffer.text = "A"; // undone before the write settled
    expect(gate.complete("A")).toBe(true);
    expect(dirtyRef.current).toBe(false);
  });
});

describe("takeFollowUp", () => {
  it("surfaces exactly one follow-up for coalesced dirty requests", () => {
    const { gate } = makeGate({ text: "A" });
    gate.begin();
    expect(gate.begin()).toBe(false);
    expect(gate.begin()).toBe(false); // repeated requests collapse
    expect(gate.takeFollowUp()).toBe(true);
    expect(gate.takeFollowUp()).toBe(false);
  });
});

describe("fail", () => {
  it("keeps dirty for the next input or manual save to retry", () => {
    const { gate, dirtyRef } = makeGate({ text: "A" });
    gate.begin();
    gate.fail();
    expect(dirtyRef.current).toBe(true);
    // The slot is released, so a retry can start right away.
    expect(gate.begin()).toBe(true);
  });
});

describe("flush", () => {
  it("resolves immediately when no write is in flight", async () => {
    const { gate } = makeGate({ text: "A" }, false);
    await expect(gate.flush()).resolves.toBeUndefined();
  });

  it("waits until the in-flight write settles (either outcome)", async () => {
    const buffer = { text: "A" };
    const { gate } = makeGate(buffer);
    gate.begin();
    let settled = false;
    void gate.flush().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    buffer.text = "AB"; // edited mid-write
    gate.complete("A"); // dirty survives → a follow-up save is expected
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(true);
    expect(gate.begin()).toBe(true); // follow-up can claim the slot
  });

  it("wakes every waiter, not just the last one", async () => {
    const { gate } = makeGate({ text: "A" });
    gate.begin();
    const a = gate.flush();
    const b = gate.flush();
    gate.complete("A");
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
  });
});
