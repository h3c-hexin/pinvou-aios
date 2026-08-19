import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import electron from "electron";

const electronDirectory = path.dirname(fileURLToPath(import.meta.url));
const mainModule = path.join(electronDirectory, "main.mjs");

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("unable to reserve a Chromium debugging port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

const cdpPort = await reserveLoopbackPort();
const electronArguments = [mainModule];
if (process.env.PINVOU_ELECTRON_NO_SANDBOX === "1") {
  console.warn("[pinvou-aios] WARNING: Chromium sandbox is disabled for this development run");
  electronArguments.push("--no-sandbox");
} else if (process.platform === "linux") {
  const sandboxPath = path.join(path.dirname(electron), "chrome-sandbox");
  const sandbox = fs.statSync(sandboxPath);
  if (sandbox.uid !== 0 || (sandbox.mode & 0o4000) === 0) {
    throw new Error(
      `Electron Chromium sandbox is not configured. Run:\n` +
      `  sudo chown root:root ${sandboxPath}\n` +
      `  sudo chmod 4755 ${sandboxPath}`,
    );
  }
}
const child = spawn(electron, electronArguments, {
  env: {
    ...process.env,
    PINVOU_BROWSER_CDP_PORT: String(cdpPort),
  },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  console.error(`failed to start Pinvou AIOS Electron shell: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
