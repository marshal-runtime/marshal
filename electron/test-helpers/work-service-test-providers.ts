import type { WorkServiceProviders } from "../work-services/contracts";

export function createTestWorkServiceProviders(): WorkServiceProviders {
  return {
    notifications: {
      id: "test-notifications",
      isAvailable: () => true,
      getStatus: () => ({
        connected: false,
        processing: false,
        metadata: { displaced: false },
      }),
      connect: async () => undefined,
      disconnect: () => undefined,
      send: async () => undefined,
    },
  };
}
