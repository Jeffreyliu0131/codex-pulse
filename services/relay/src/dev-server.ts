import { createServer } from "node:http";
import { loadConfig } from "./env.ts";
import { createRelayHandler } from "./http.ts";
import { handleNodeRequest } from "./node-adapter.ts";
import { PostgresStore } from "./postgres-store.ts";

const config = loadConfig();
const store = new PostgresStore(config.databaseUrl);
const handler = createRelayHandler({ store, config });
const port = Number.parseInt(process.env.PORT ?? "8787", 10);

const server = createServer((request, response) => {
  void handleNodeRequest(request, response, handler);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`CodexPulse Relay listening on http://127.0.0.1:${port}\n`);
});
