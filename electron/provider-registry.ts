export interface ProviderInstance {
  id: string;
}

export interface ProviderRegistration<TContext, TInstance extends ProviderInstance> {
  id: string;
  create(context: TContext): TInstance;
}

export class ProviderRegistry<TContext, TInstance extends ProviderInstance> {
  private readonly registrations = new Map<string, ProviderRegistration<TContext, TInstance>>();

  register(registration: ProviderRegistration<TContext, TInstance>): () => void {
    const id = registration.id.trim();
    if (!id) throw new Error("Provider ID must be a non-empty string");
    if (this.registrations.has(id)) {
      throw new Error(`Provider "${id}" is already registered`);
    }
    this.registrations.set(id, { ...registration, id });
    return () => {
      if (this.registrations.get(id)?.create === registration.create) {
        this.registrations.delete(id);
      }
    };
  }

  create(id: string, context: TContext): TInstance {
    const normalized = id.trim();
    const registration = this.registrations.get(normalized);
    if (!registration) {
      const available = this.ids().join(", ") || "(none)";
      throw new Error(`Unknown provider "${normalized || id}". Registered providers: ${available}`);
    }
    const instance = registration.create(context);
    if (instance.id !== normalized) {
      throw new Error(
        `Provider factory registered as "${normalized}" returned instance "${instance.id}"`,
      );
    }
    return instance;
  }

  ids(): string[] {
    return [...this.registrations.keys()].sort();
  }

  has(id: string): boolean {
    return this.registrations.has(id.trim());
  }
}
