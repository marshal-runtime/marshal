import type { RemoteAccessAPI } from "../../common/remote-access";
declare global {
  interface Window {
    remoteAccessAPI?: RemoteAccessAPI;
    marshalRemote?: boolean;
    marshalCloudRemote?: boolean;
  }
}

