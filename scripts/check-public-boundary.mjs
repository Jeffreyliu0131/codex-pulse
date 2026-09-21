import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Include proposed new files, exclude ignored runtime material. Never print matches.
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0").filter(Boolean);
const forbiddenPath = /(^|\/)(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|auth\.json|\.vercel|secrets|node_modules|\.build|dist|.*\.(?:pem|key|sqlite|db|bundle))($|\/)/i;
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["credential token", /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{40,})/],
  ["personal machine path", /\/Users\/(?!test(?:\/|["'])|example(?:\/|["']))[A-Za-z0-9_.-]+\//],
  ["private deployment address", /https:\/\/[a-z0-9-]+-[a-z0-9]+-jeffreyliu[^\s"')]*\.vercel\.app/i],
];
let failures = 0;
for (const path of files) {
  if (path !== ".env.example" && forbiddenPath.test(path)) {
    console.log(`blocked: ${path} (runtime/private file)`);
    failures += 1;
    continue;
  }
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  let source = bytes.toString("utf8");
  if (["apps/macos-bridge/Sources/CodexPulseBridgeSelfTest/main.swift", "apps/macos-bridge/Tests/CodexPulseBridgeCoreTests/BridgeCoreTests.swift"].includes(path)) {
    source = source.replaceAll(["", "Users", "private", "repo"].join("/"), "SYNTHETIC_REDACTION_FIXTURE");
  }
  for (const [name, pattern] of patterns) {
    if (pattern.test(source)) {
      console.log(`blocked: ${path} (${name}; value hidden)`);
      failures += 1;
    }
  }
}
console.log(`Public boundary: ${files.length} candidate files, ${failures} finding(s). Heuristic scan; review the diff and assets too.`);
process.exitCode = failures ? 1 : 0;
