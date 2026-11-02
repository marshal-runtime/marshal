import { useQuery } from "@tanstack/react-query";

export function useMarshalDefaultWorkspaceDir() {
  const { data } = useQuery<string | undefined>({
    queryKey: ["defaultWorkspaceDir"],
    queryFn: async () => {
      if (!window.appAPI?.getDefaultWorkspaceDir) return undefined;
      const result = await window.appAPI.getDefaultWorkspaceDir();
      return result.success ? result.defaultWorkspaceDir : undefined;
    },
    staleTime: Infinity,
  });

  return data;
}
