import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const browserDirectory = path.dirname(fileURLToPath(import.meta.url));

export const defaultPlaywrightCliPath = path.join(
  browserDirectory,
  "node_modules",
  ".bin",
  "playwright-cli",
);
export const defaultPlaywrightCliConfigPath = path.join(browserDirectory, "cli.config.json");
export const defaultBrowserCdpStatePath = path.join(
  process.env.PINVOU_AIOS_HOME || path.join(os.homedir(), ".pinvou-aios"),
  "run",
  "browser-cdp.json",
);

export function discoverEmbeddedBrowserEndpoint(
  statePath = process.env.PINVOU_BROWSER_CDP_STATE || defaultBrowserCdpStatePath,
) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const endpoint = new URL(state.endpoint);
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
      return undefined;
    }
    if (!Number.isInteger(state.pid) || state.pid <= 0) return undefined;
    process.kill(state.pid, 0);
    return endpoint.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function validatePlaywrightCliArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error("playwright_cli requires a non-empty args array");
  }
  for (const argument of args) {
    if (typeof argument !== "string") {
      throw new Error("every playwright_cli argument must be a string");
    }
    if (argument.includes("\0")) {
      throw new Error("playwright_cli arguments cannot contain NUL bytes");
    }
  }
  return args;
}

export function buildPlaywrightCliEnvironment(overrides = {}) {
  const embeddedBrowserEndpoint =
    overrides.PLAYWRIGHT_MCP_CDP_ENDPOINT ||
    process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT ||
    discoverEmbeddedBrowserEndpoint();
  return {
    ...process.env,
    PLAYWRIGHT_CLI_SESSION: process.env.PLAYWRIGHT_CLI_SESSION || "pinvou-main",
    PLAYWRIGHT_MCP_HEADLESS: process.env.PLAYWRIGHT_MCP_HEADLESS || "false",
    PLAYWRIGHT_MCP_CONFIG:
      process.env.PLAYWRIGHT_MCP_CONFIG || defaultPlaywrightCliConfigPath,
    ...(embeddedBrowserEndpoint
      ? { PLAYWRIGHT_MCP_CDP_ENDPOINT: embeddedBrowserEndpoint }
      : {}),
    ...overrides,
  };
}

function executePlaywrightCli(args, options = {}) {
  const executable = options.executable || process.env.PINVOU_PLAYWRIGHT_CLI || defaultPlaywrightCliPath;
  const cwd = options.cwd || process.cwd();
  const maxOutputBytes = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
  const env = options.resolvedEnv || buildPlaywrightCliEnvironment(options.env);

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let truncated = false;

    const append = (target, chunk) => {
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      const bytes = Buffer.from(chunk);
      const accepted = bytes.subarray(0, remaining).toString("utf8");
      outputBytes += Math.min(bytes.length, remaining);
      if (bytes.length > remaining) truncated = true;
      return target + accepted;
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });

    const abort = () => child.kill("SIGTERM");
    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }

    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", abort);
      reject(
        new Error(
          `failed to start playwright-cli at ${executable}: ${error.message}. ` +
            "Run `npm --prefix browser ci --ignore-scripts` first.",
        ),
      );
    });
    child.on("close", (code, signal) => {
      options.signal?.removeEventListener("abort", abort);
      const suffix = truncated ? "\n[output truncated by Pinvou AIOS]" : "";
      const result = {
        args,
        code,
        signal,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        truncated,
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      const diagnostic = [result.stdout, result.stderr].filter(Boolean).join("\n");
      reject(
        new Error(
          `playwright-cli exited with ${code ?? signal ?? "unknown status"}` +
            (diagnostic ? `:\n${diagnostic}${suffix}` : ""),
        ),
      );
    });
  });
}

function commandName(args) {
  if (args.includes("--help") || args.includes("--version")) return undefined;
  return args.find((argument) => !argument.startsWith("-"));
}

async function ensureEmbeddedBrowserSession(options, env) {
  const endpoint = env.PLAYWRIGHT_MCP_CDP_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      "Pinvou AIOS 内置 Chromium 尚未运行。请先启动 PAD UI；浏览器工具不会回退打开外部 Chrome。",
    );
  }

  const sessionName = env.PLAYWRIGHT_CLI_SESSION || "pinvou-main";
  const internalOptions = { ...options, resolvedEnv: env };
  const listResult = await executePlaywrightCli(["--json", "list"], internalOptions);
  let current;
  try {
    const list = JSON.parse(listResult.stdout);
    current = list.browsers?.find((browser) => browser.name === sessionName);
  } catch {
    // A malformed list is treated as a missing session and repaired below.
  }
  if (current?.status === "open" && current.attached) return;

  if (current) {
    await executePlaywrightCli(["close"], internalOptions).catch(() => undefined);
  }
  await executePlaywrightCli(
    ["attach", `--cdp=${endpoint}`, `--session=${sessionName}`],
    internalOptions,
  );

  const tabsResult = await executePlaywrightCli(["--json", "tab-list"], internalOptions);
  try {
    const tabs = JSON.parse(tabsResult.stdout).result;
    const lines = String(tabs).split("\n");
    const surface =
      lines.find((line) => line.includes("about:blank#pinvou-browser-surface")) ||
      lines.find(
        (line) =>
          !line.includes("/apps/pad-ui/dist/index.html") &&
          !line.includes("localhost:1420") &&
          !line.includes("127.0.0.1:1420"),
      );
    const index = surface?.match(/^- (\d+):/)?.[1];
    if (index !== undefined) {
      await executePlaywrightCli(["tab-select", index], internalOptions);
    }
  } catch {
    // A later browser command will surface an actionable CLI error if selection failed.
  }
}

export async function runPlaywrightCli(args, options = {}) {
  validatePlaywrightCliArgs(args);
  const env = buildPlaywrightCliEnvironment(options.env);
  const command = commandName(args);
  const passthroughCommands = new Set([
    undefined,
    "list",
    "install",
    "install-browser",
    "attach",
    "detach",
    "close-all",
    "kill-all",
  ]);

  if (passthroughCommands.has(command)) {
    return executePlaywrightCli(args, { ...options, resolvedEnv: env });
  }

  await ensureEmbeddedBrowserSession(options, env);
  if (command !== "open") {
    return executePlaywrightCli(args, { ...options, resolvedEnv: env });
  }

  const commandIndex = args.indexOf("open");
  const location = args.slice(commandIndex + 1).find((argument) => !argument.startsWith("-"));
  const outputOptions = args.filter((argument) => argument === "--json" || argument === "--raw");
  const mappedArgs = location
    ? [...outputOptions, "goto", location]
    : [...outputOptions, "snapshot"];
  const result = await executePlaywrightCli(mappedArgs, { ...options, resolvedEnv: env });
  return { ...result, args, executedArgs: mappedArgs };
}
