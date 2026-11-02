/** A one-off wake of one session: the message arrives in that session at the given moment. */
export interface RuntimeOneOffWakeInput {
  sessionId: string;
  message: string;
  at: Date;
}

/** The stored one-off wake that the runtime scheduler fires. */
export interface RuntimeOneOffWake {
  scheduleId: string;
  at: string;
}

/** The runtime scheduler as the self-tools use it for one-off session wakes. */
export interface RuntimeOneOffWakes {
  schedule(input: RuntimeOneOffWakeInput): Promise<RuntimeOneOffWake>;
  cancel(scheduleId: string): Promise<boolean>;
}
