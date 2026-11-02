export interface RemoteAccessState {
  enabled: boolean;
  running: boolean;
  origin: string;
  port: number;
  accessKey: string;
  error?: string;
}
export interface RemoteAccessAPI {
  setupTailscale: () => Promise<RemoteAccessState>;
  getState: () => Promise<RemoteAccessState>;
  configure: (input: {
    enabled: boolean;
    origin: string;
    rotateKey?: boolean;
  }) => Promise<RemoteAccessState>;
}
