import "@testing-library/jest-dom/vitest";

// Polyfill ResizeObserver for jsdom - triggers callback immediately
class ResizeObserverMock {
  private callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    // Trigger immediately with non-zero size to simulate visible container
    setTimeout(() => {
      this.callback(
        [
          {
            contentRect: { x: 0, y: 0, width: 800, height: 600, top: 0, right: 800, bottom: 600, left: 0, toJSON() {} },
            target: null as any,
          } as any,
        ],
        this as any,
      );
    }, 0);
  }

  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = ResizeObserverMock;
}

// jsdom has no layout engine; scrollIntoView is a no-op the read-mode
// highlighter calls.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
