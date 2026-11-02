import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Collect the files owned by a runtime-extension package.
 *
 * Package managers may install dependency trees inside the package. Those
 * dependencies are verified by the lockfile and are not part of the signed
 * extension archive, so they must not affect the extension content digest.
 */
export async function collectRuntimeExtensionPackageFiles(root) {
  const files = [];
  const visit = async (directory) => {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) =>
      Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")),
    );
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name === "node_modules") continue;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Runtime extension package contains a symbolic link: ${entry.name}.`);
      }
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile()) {
        files.push(target);
      } else {
        throw new Error(`Runtime extension package contains an unsupported entry: ${entry.name}.`);
      }
    }
  };
  await visit(root);
  return files;
}
