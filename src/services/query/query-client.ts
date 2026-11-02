import { QueryClient, type QueryClientConfig } from "@tanstack/react-query";

const queryClientConfig: QueryClientConfig = {
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 5_000,
      refetchOnWindowFocus: true,
    },
  },
};

export const queryClient = new QueryClient(queryClientConfig);
