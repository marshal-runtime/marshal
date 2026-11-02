import type { BackendOrigin } from "../../common/marshal-ipc-contract";
import type { RuntimeClientFactory } from "./runtime-contract";
import type { IBackendProvider } from "./types";

export interface RuntimeAdapterCreateContext {
  workspaceDir: string;
  mockMode: boolean;
  isPackaged?: boolean;
  resourcesPath?: string;
}

export interface RuntimeAdapterRegistration<TContext extends RuntimeAdapterCreateContext> {
  id: string;
  origin: BackendOrigin;
  create(context: TContext): IBackendProvider;
  /** `accountId` selects an extra account's credential home; omit it for the original account. */
  createClientFactory?(context: TContext, accountId?: string): RuntimeClientFactory;
}

export class RuntimeAdapterRegistry<TContext extends RuntimeAdapterCreateContext> {
  private readonly registrations = new Map<string, RuntimeAdapterRegistration<TContext>>();

  register(registration: RuntimeAdapterRegistration<TContext>): void {
    const id = registration.id.trim();
    if (!id) throw new Error("Runtime adapter ID must be a non-empty string");
    if (this.registrations.has(id)) {
      throw new Error(`Runtime adapter "${id}" is already registered`);
    }
    this.registrations.set(id, { ...registration, id });
  }

  create(id: string, context: TContext): IBackendProvider {
    const registration = this.getRequired(id);
    const backend = registration.create(context);
    if (backend.runtimeId !== registration.id) {
      throw new Error(
        `Runtime adapter "${registration.id}" created backend with runtimeId "${backend.runtimeId}"`,
      );
    }
    if (backend.origin !== registration.origin) {
      throw new Error(
        `Runtime adapter "${registration.id}" created backend with origin "${backend.origin}" instead of "${registration.origin}"`,
      );
    }
    return backend;
  }

  createClientFactory(
    id: string,
    context: TContext,
    accountId?: string,
  ): RuntimeClientFactory | null {
    return this.getRequired(id).createClientFactory?.(context, accountId) ?? null;
  }

  ids(): string[] {
    return [...this.registrations.keys()];
  }

  private getRequired(id: string): RuntimeAdapterRegistration<TContext> {
    const normalized = id.trim();
    const registration = this.registrations.get(normalized);
    if (registration) return registration;
    const available = this.ids().sort().join(", ") || "(none)";
    throw new Error(
      `Unknown runtime adapter "${normalized || id}". Registered runtimes: ${available}`,
    );
  }
}
