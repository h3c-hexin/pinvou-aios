import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlaywrightCliEnvironment,
  discoverEmbeddedBrowserEndpoint,
  defaultPlaywrightCliConfigPath,
  defaultPlaywrightCliPath,
  runPlaywrightCli,
  validatePlaywrightCliArgs,
} from "./runner.js";

test("validates argv without interpreting playwright-cli commands", () => {
  const args = ["run-code", "async page => page.title()", "--json"];
  assert.equal(validatePlaywrightCliArgs(args), args);
  assert.throws(() => validatePlaywrightCliArgs([]), /non-empty args array/);
  assert.throws(() => validatePlaywrightCliArgs(["goto", 42]), /must be a string/);
  assert.throws(() => validatePlaywrightCliArgs(["goto", "bad\0url"]), /NUL bytes/);
});

test("executes the pinned playwright-cli binary without a shell", async () => {
  const result = await runPlaywrightCli(["--version"], {
    executable: defaultPlaywrightCliPath,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "0.1.18");
});

test("uses the Pinvou Chromium config by default", () => {
  const env = buildPlaywrightCliEnvironment({
    PLAYWRIGHT_MCP_CDP_ENDPOINT: "http://127.0.0.1:9222",
  });
  assert.equal(env.PLAYWRIGHT_CLI_SESSION, "pinvou-main");
  assert.equal(env.PLAYWRIGHT_MCP_HEADLESS, "false");
  assert.equal(env.PLAYWRIGHT_MCP_CONFIG, defaultPlaywrightCliConfigPath);
  assert.equal(env.PLAYWRIGHT_MCP_CDP_ENDPOINT, "http://127.0.0.1:9222");
  assert.ok(env.PLAYWRIGHT_MCP_CONFIG.endsWith("browser/cli.config.json"));
});

test("ignores missing or untrusted embedded browser endpoints", () => {
  assert.equal(discoverEmbeddedBrowserEndpoint("/definitely/missing/browser-cdp.json"), undefined);
});
