import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const configFile = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
if (configFile.error) {
  throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
}

const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, process.cwd());

function transpile(path) {
  return ts.transpileModule(readFileSync(path, "utf8"), {
    fileName: path,
    compilerOptions: {
      ...config.options,
      noEmit: false,
    },
  }).outputText;
}

test("Vercel runtime emit rewrites TypeScript source imports to JavaScript", () => {
  const api = transpile("api/index.ts");
  const relay = transpile("services/relay/src/http.ts");

  assert.match(api, /services\/relay\/src\/env\.js/);
  assert.match(relay, /packages\/contracts\/src\/index\.js/);
  assert.doesNotMatch(api, /from ["'][^"']+\.ts["']/);
  assert.doesNotMatch(relay, /from ["'][^"']+\.ts["']/);
});
