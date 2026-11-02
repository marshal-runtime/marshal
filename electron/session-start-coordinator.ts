export interface SessionStartContext {
  readonly epoch: number;
  assertCurrent(): void;
  isCurrent(): boolean;
  recapture(): SessionStartContext;
}

interface RestartFlight {
  promise: Promise<number>;
}

export class StaleSessionStartError extends Error {
  constructor(
    readonly startedEpoch: number,
    readonly currentEpoch: number,
  ) {
    super(`Session start from runtime epoch ${startedEpoch} completed in epoch ${currentEpoch}`);
    this.name = "StaleSessionStartError";
  }
}

export class SessionStartCoordinatorStoppedError extends Error {
  constructor() {
    super("Session manager is shutting down; new session starts are disabled");
    this.name = "SessionStartCoordinatorStoppedError";
  }
}

export class SessionStartCoordinator {
  private readonly flights = new Map<string, Promise<unknown>>();
  private runtimeEpoch = 0;
  private restartFlight: RestartFlight | null = null;
  private stopped = false;
  private shutdownPromise: Promise<void> | null = null;

  run<T>(sessionId: string, task: (context: SessionStartContext) => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new SessionStartCoordinatorStoppedError());
    const existing = this.flights.get(sessionId);
    if (existing) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same-session callers share the canonical start result
      return existing as Promise<T>;
    }

    const promise = this.waitForRuntimeTransition()
      .then(() => task(this.createContext()))
      .finally(() => {
        if (this.flights.get(sessionId) === promise) this.flights.delete(sessionId);
      });
    this.flights.set(sessionId, promise);
    return promise;
  }

  restartRuntime(restart: () => Promise<void>): Promise<number> {
    if (this.stopped) return Promise.reject(new SessionStartCoordinatorStoppedError());
    if (this.restartFlight) return this.restartFlight.promise;
    return this.beginRestart(restart);
  }

  async transitionRuntime(transition: () => Promise<void>): Promise<number> {
    if (this.stopped) throw new SessionStartCoordinatorStoppedError();
    const activeRestart = this.restartFlight;
    if (activeRestart) {
      await activeRestart.promise;
      return this.transitionRuntime(transition);
    }
    return this.beginRestart(transition);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopped = true;
    this.shutdownPromise = this.drain();
    return this.shutdownPromise;
  }

  async waitForRuntimeTransition(): Promise<number> {
    const restart = this.restartFlight;
    if (restart) await restart.promise;
    return this.runtimeEpoch;
  }

  captureContext(): SessionStartContext {
    return this.createContext();
  }

  private createContext(): SessionStartContext {
    const epoch = this.runtimeEpoch;
    const context: SessionStartContext = {
      epoch,
      assertCurrent: () => {
        if (!context.isCurrent()) throw new StaleSessionStartError(epoch, this.runtimeEpoch);
      },
      isCurrent: () => epoch === this.runtimeEpoch,
      recapture: () => this.createContext(),
    };
    return context;
  }

  private async drain(): Promise<void> {
    const pending = [
      ...this.flights.values(),
      ...(this.restartFlight ? [this.restartFlight.promise] : []),
    ];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
    return this.drain();
  }

  private beginRestart(restart: () => Promise<void>): Promise<number> {
    if (this.restartFlight) return this.restartFlight.promise;

    this.runtimeEpoch += 1;
    const nextEpoch = this.runtimeEpoch;
    const promise = Promise.resolve()
      .then(() => {
        if (this.stopped) throw new SessionStartCoordinatorStoppedError();
        return restart();
      })
      .then(() => nextEpoch);
    const flight: RestartFlight = { promise };
    this.restartFlight = flight;
    void promise.then(
      () => {
        if (this.restartFlight === flight) this.restartFlight = null;
      },
      () => {
        if (this.restartFlight === flight) this.restartFlight = null;
      },
    );
    return promise;
  }
}
