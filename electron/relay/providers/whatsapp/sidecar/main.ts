import { runWhatsAppSidecarProcess } from "./process";

try {
  await runWhatsAppSidecarProcess();
} catch {
  process.exitCode = 1;
}
