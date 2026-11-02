import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEBUGGER_HOST_ADAPTER_SERVICE,
  type DebuggerHostAdapter,
} from "@marshal/agentic-debugger-extension";
import {
  type RuntimeCompositionRegistry,
  type RuntimeCompositionServiceDescriptor,
  type RuntimeServiceBindingHandle,
} from "@marshal/runtime";
import type {
  LoadedRuntimeExtensionPackage,
  RuntimeExtensionActivation,
} from "@marshal/runtime/extensions";

import { BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY } from "./agentic-debugger-extension";

const NATIVE_DEBUGGER_ENTRYPOINT = path.join("dist", "runtime", "native-host.mjs");
const DEBUGGER_HOST_SERVICE_KEY = "marshal.agentic-debugger.host-adapter";
const NATIVE_DEBUGGER_PROVIDER_PREFIX = `${BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY}:native:`;

const DEBUGGER_HOST_DECLARATION = `export interface IDebuggerHostAdapter {
  invoke(input: unknown): Promise<unknown>;
}`;

export const AGENTIC_DEBUGGER_HOST_COMPOSITION_SERVICE: RuntimeCompositionServiceDescriptor<DebuggerHostAdapter> =
  Object.freeze({
    key: DEBUGGER_HOST_SERVICE_KEY,
    token: DEBUGGER_HOST_ADAPTER_SERVICE,
    contract: Object.freeze({
      name: DEBUGGER_HOST_SERVICE_KEY,
      version: "1.0.0",
      declaration: DEBUGGER_HOST_DECLARATION,
      methods: Object.freeze([
        Object.freeze({
          name: "invoke",
          input: "unknown",
          output: "unknown",
          description: "Invoke the debugger adapter selected for the installed extension package.",
        }),
      ]),
    }),
  });

export const unavailableDebuggerHostAdapter: DebuggerHostAdapter = Object.freeze({
  async invoke(): Promise<never> {
    throw Object.assign(
      new Error("The installed debugger extension did not activate a native host adapter."),
      { code: "WORKER_UNAVAILABLE" },
    );
  },
});

export async function bindAgenticDebuggerHostAdapter(
  compositionRegistry: RuntimeCompositionRegistry,
  providerId: string,
  adapter: DebuggerHostAdapter,
  options: { readonly select?: boolean } = {},
): Promise<RuntimeServiceBindingHandle> {
  const previousOverride = compositionRegistry.snapshot().overrides[DEBUGGER_HOST_SERVICE_KEY];
  const binding = await compositionRegistry.registerProvider({
    provider: {
      id: providerId,
      service: AGENTIC_DEBUGGER_HOST_COMPOSITION_SERVICE,
      contract: AGENTIC_DEBUGGER_HOST_COMPOSITION_SERVICE.contract,
    },
    binding: { useValue: adapter },
  });
  if (options.select) {
    try {
      await compositionRegistry.setProviderOverride(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- registry override APIs erase the descriptor value type to unknown
        AGENTIC_DEBUGGER_HOST_COMPOSITION_SERVICE as RuntimeCompositionServiceDescriptor,
        providerId,
      );
    } catch (error) {
      await binding.dispose();
      throw error;
    }
  }
  return {
    dispose: async () => {
      const failures: unknown[] = [];
      const snapshot = compositionRegistry.snapshot();
      if (snapshot.overrides[DEBUGGER_HOST_SERVICE_KEY] === providerId) {
        const previousStillRegistered =
          previousOverride !== undefined &&
          snapshot.services
            .find((service) => service.service.key === DEBUGGER_HOST_SERVICE_KEY)
            ?.providers.some(
              ({ provider, status }) =>
                provider.id === previousOverride &&
                status !== "incompatible" &&
                status !== "collision",
            );
        try {
          if (previousStillRegistered) {
            await compositionRegistry.setProviderOverride(
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- registry override APIs erase the descriptor value type to unknown
              AGENTIC_DEBUGGER_HOST_COMPOSITION_SERVICE as RuntimeCompositionServiceDescriptor,
              previousOverride,
            );
          } else {
            await compositionRegistry.clearProviderOverride(
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- registry override APIs erase the descriptor value type to unknown
              AGENTIC_DEBUGGER_HOST_COMPOSITION_SERVICE as RuntimeCompositionServiceDescriptor,
            );
          }
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await binding.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          `Failed to remove debugger host provider ${providerId}.`,
        );
      }
    },
  };
}

export function adaptAgenticDebuggerExtensionPackage(
  loaded: LoadedRuntimeExtensionPackage,
  compositionRegistry: RuntimeCompositionRegistry,
): LoadedRuntimeExtensionPackage {
  const activate = loaded.module.activate.bind(loaded.module);
  return {
    ...loaded,
    module: {
      activate: async (context) => {
        const adapter = await loadNativeDebuggerHostAdapter(loaded.metadata.canonicalRoot);
        let binding: RuntimeServiceBindingHandle | undefined;
        let activation: RuntimeExtensionActivation;
        try {
          if (adapter) {
            binding = await bindAgenticDebuggerHostAdapter(
              compositionRegistry,
              `${NATIVE_DEBUGGER_PROVIDER_PREFIX}${loaded.metadata.integrity.value}`,
              adapter,
            );
          }
          activation = await activate(context);
        } catch (error) {
          await disposeDebuggerActivationResources(binding, adapter);
          throw error;
        }
        return {
          ...activation,
          dispose: async () => {
            const failures: unknown[] = [];
            try {
              await activation.dispose?.();
            } catch (error) {
              failures.push(error);
            }
            try {
              await binding?.dispose();
            } catch (error) {
              failures.push(error);
            }
            try {
              await adapter?.dispose?.();
            } catch (error) {
              failures.push(error);
            }
            if (failures.length > 0) {
              throw new AggregateError(
                failures,
                "Failed to dispose the Marshal agentic debugger extension.",
              );
            }
          },
        };
      },
    },
  };
}

export function isAgenticDebuggerNativeProviderId(
  providerId: string | undefined,
): providerId is string {
  return (
    providerId?.startsWith(NATIVE_DEBUGGER_PROVIDER_PREFIX) === true &&
    providerId.length > NATIVE_DEBUGGER_PROVIDER_PREFIX.length
  );
}

async function loadNativeDebuggerHostAdapter(packageRoot: string): Promise<DebuggerHostAdapter> {
  const entry = path.join(packageRoot, NATIVE_DEBUGGER_ENTRYPOINT);
  const module: unknown = await import(pathToFileURL(entry).href);
  if (typeof module !== "object" || module === null) {
    throw new Error("The debugger native host module is invalid.");
  }
  const Constructor = Reflect.get(module, "NativeDebuggerHostAdapter");
  if (typeof Constructor !== "function") {
    throw new Error("The debugger native host module does not export NativeDebuggerHostAdapter.");
  }
  const adapter: unknown = Reflect.construct(Constructor, []);
  if (typeof adapter !== "object" || adapter === null) {
    throw new Error("The debugger native host module returned an invalid adapter.");
  }
  const invoke: unknown = Reflect.get(adapter, "invoke");
  if (typeof invoke !== "function") {
    throw new Error("The debugger native host module returned an invalid adapter.");
  }
  const dispose: unknown = Reflect.get(adapter, "dispose");
  return {
    invoke: async (input) => Reflect.apply(invoke, adapter, [input]),
    ...(typeof dispose === "function"
      ? { dispose: async () => Reflect.apply(dispose, adapter, []) }
      : {}),
  };
}

async function disposeDebuggerActivationResources(
  binding: RuntimeServiceBindingHandle | undefined,
  adapter: DebuggerHostAdapter | undefined,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await binding?.dispose();
  } catch (error) {
    failures.push(error);
  }
  try {
    await adapter?.dispose?.();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "Failed to clean up the Marshal agentic debugger host adapter.",
    );
  }
}
