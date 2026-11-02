import type {
  RuntimeUiChatCardCommand,
  RuntimeUiContent,
  RuntimeUiInstance,
  RuntimeUiOpenCommand,
  RuntimeUiOwner,
  RuntimeUiSurface,
  RuntimeUiViewOptions,
} from "../../common/runtime-ui";
import {
  failure,
  immutable,
  isoTime,
  normalizeSurface,
  ownerOf,
  sameScope,
  scopeOf,
  type RuntimeUiEventInput,
} from "./ui-controller-support";
import {
  normalizeViewOptions,
  pickViewOptions,
  RuntimeUiExpiryScheduler,
  viewFieldsForSurface,
} from "./ui-view-options";

/** The controller state and validation the view lifecycle works through. */
export interface RuntimeUiViewLifecycleHost {
  readonly instances: Map<string, RuntimeUiInstance>;
  readonly clock: () => number;
  nextRevision(): number;
  record(event: RuntimeUiEventInput): void;
  isDisposed(): boolean;
  normalizeOwner(owner: RuntimeUiOwner): RuntimeUiOwner;
  normalizeContent(content: RuntimeUiContent): RuntimeUiContent;
}

type ViewCommand = RuntimeUiOpenCommand | RuntimeUiChatCardCommand;
type ViewFields = Pick<RuntimeUiInstance, "title" | "transient" | "anchor">;

/**
 * View-level lifecycle on top of the runtime UI controller: open-time view
 * options, transient-card expiry, in-place replacement, and restore after a
 * restart.
 */
export class RuntimeUiViewLifecycle {
  private readonly expiry: RuntimeUiExpiryScheduler;

  constructor(private readonly host: RuntimeUiViewLifecycleHost) {
    this.expiry = new RuntimeUiExpiryScheduler(host.clock, (instanceId) => this.expire(instanceId));
  }

  options(command: ViewCommand, surface: RuntimeUiSurface): ViewFields {
    return normalizeViewOptions(command, surface, this.host.clock(), (message) =>
      failure("invalid-request", message),
    );
  }

  /** Validates view options now but keeps them raw, so idempotency digests stay time-independent. */
  rawOptions(command: ViewCommand, surface: RuntimeUiSurface): RuntimeUiViewOptions {
    this.options(command, surface);
    return pickViewOptions(command);
  }

  sync(instance: RuntimeUiInstance): void {
    this.expiry.sync(instance);
  }

  cancel(instanceId: string): void {
    this.expiry.cancel(instanceId);
  }

  dispose(): void {
    this.expiry.dispose();
  }

  /**
   * Swaps a view's content (and application identity) under its existing id,
   * so a re-rendered view keeps its tab, card position, or inline slot.
   */
  replace(command: RuntimeUiOpenCommand): RuntimeUiInstance {
    const current = command.replaceInstanceId
      ? this.host.instances.get(command.replaceInstanceId)
      : undefined;
    if (
      !current ||
      !sameScope(current.owner, command) ||
      current.owner.extensionId !== command.extensionId
    ) {
      throw failure("not-found", "The view to replace was not found for this owner and scope.");
    }
    const options = this.options(command, command.surface);
    const instance = immutable<RuntimeUiInstance>({
      ...current,
      owner: ownerOf(command),
      surface: command.surface,
      content: command.content,
      revision: this.host.nextRevision(),
      updatedAt: isoTime(this.host.clock()),
      ...viewFieldsForSurface(current, command.surface),
      ...options,
    });
    this.host.instances.set(instance.instanceId, instance);
    this.sync(instance);
    this.host.record({ type: "instance-updated", scope: scopeOf(command), instance });
    return instance;
  }

  /**
   * Re-opens views persisted with a session after a restart. Content passes
   * through normal validation so file views get fresh read capabilities.
   * Views whose ids are already open are left untouched.
   */
  restore(saved: readonly RuntimeUiInstance[]): number {
    let restored = 0;
    for (const view of saved) {
      if (this.host.instances.has(view.instanceId) || view.transient) continue;
      try {
        const owner = this.host.normalizeOwner(view.owner);
        const instance = immutable<RuntimeUiInstance>({
          ...view,
          owner,
          surface: normalizeSurface(view.surface),
          content: this.host.normalizeContent(view.content),
          revision: this.host.nextRevision(),
        });
        this.host.instances.set(instance.instanceId, instance);
        this.host.record({ type: "instance-opened", scope: scopeOf(owner), instance });
        restored++;
      } catch {
        // A saved view that no longer validates is dropped rather than restored.
      }
    }
    return restored;
  }

  private expire(instanceId: string): void {
    if (this.host.isDisposed()) return;
    const current = this.host.instances.get(instanceId);
    if (!current?.transient) return;
    this.host.instances.delete(instanceId);
    this.host.record({
      type: "instance-closed",
      scope: scopeOf(current.owner),
      instanceId,
      owner: current.owner,
      reason: "expired",
    });
  }
}
