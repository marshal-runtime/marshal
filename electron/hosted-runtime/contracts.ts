/**
 * Provider-neutral hosted-runtime contract.
 *
 * The gateway backend needs three things from whoever hosts the runtime: where
 * to connect, how to authenticate the upgrade request, and where the device
 * key material used for pairing lives. Which directory mints the token, and
 * whether the endpoint is baked into a build profile or read from config, is
 * the hosting provider's business — not the backend's.
 */

export interface HostedRuntimeEndpoint {
  /** Transport URL for the hosted runtime (`ws://` or `wss://`). */
  url: string;
  /** Shared handshake token the runtime expects on the upgrade request. */
  sharedToken: string;
}

export interface HostedRuntimeProvider {
  readonly id: string;
  /** Endpoint used when connecting as an authenticated principal. */
  resolveEndpoint(): HostedRuntimeEndpoint;
  /**
   * Bearer token for the upgrade request. `undefined` means the runtime accepts
   * the connection without a principal token (local/dev runtimes).
   */
  acquireAuthToken(): Promise<string | undefined>;
  /**
   * Location of the device key pair used to sign pairing challenges. Providers
   * that do not relocate device trust return `defaultPath` unchanged.
   */
  resolveDeviceIdentityPath(defaultPath: string): string;
}

export type HostedRuntimeProviderFactory = () => HostedRuntimeProvider;

export class HostedRuntimeRegistry {
  private readonly factories = new Map<string, HostedRuntimeProviderFactory>();

  register(id: string, factory: HostedRuntimeProviderFactory): void {
    if (id.trim() !== id || id.length === 0) {
      throw new Error("Hosted runtime provider ID must be a non-empty, trimmed string");
    }
    if (this.factories.has(id)) {
      throw new Error(`Hosted runtime provider "${id}" is already registered`);
    }
    this.factories.set(id, factory);
  }

  has(id: string): boolean {
    return this.factories.has(id);
  }

  registeredIds(): string[] {
    return [...this.factories.keys()].sort();
  }

  create(id: string): HostedRuntimeProvider {
    const factory = this.factories.get(id);
    if (!factory) {
      throw new Error(
        `Unknown hosted runtime provider "${id}". Registered providers: ${
          this.registeredIds().join(", ") || "(none)"
        }`,
      );
    }
    const provider = factory();
    if (provider.id !== id) {
      throw new Error(
        `Hosted runtime provider factory registered as "${id}" returned provider "${provider.id}"`,
      );
    }
    return provider;
  }
}
