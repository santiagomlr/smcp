// While a send confirmation is open, nothing the AI can drive may click or type on this screen.
// One gate per process: confirmations and screen actions always run in the same one.
export function createConfirmGate() {
  let confirming = 0;
  let acting = 0;
  let waiters = [];

  return {
    isConfirming: () => confirming > 0,

    /** Waits for screen actions already running, so none can land on the dialog once it opens. */
    async confirm(fn) {
      confirming += 1;
      try {
        while (acting > 0) await new Promise((resolve) => waiters.push(resolve));
        return await fn();
      } finally {
        confirming -= 1;
      }
    },

    /** Runs a screen action. Callers check isConfirming() first and refuse. */
    async act(fn) {
      acting += 1;
      try {
        return await fn();
      } finally {
        acting -= 1;
        if (acting === 0) {
          for (const resolve of waiters) resolve();
          waiters = [];
        }
      }
    },
  };
}

export const confirmGate = createConfirmGate();
