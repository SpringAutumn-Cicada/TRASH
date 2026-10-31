import { createWorkbenchServer } from "./index.js";

const defaultPort = process.argv.includes("--dev") ? "22223" : "22222";
const requestedPort = Number(process.env.TRASH_PORT ?? defaultPort);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error("TRASH_PORT must be an integer from 0 to 65535");

const app = createWorkbenchServer();
app.server.listen(requestedPort, "127.0.0.1", () => {
  const address = app.server.address();
  if (address && typeof address !== "string") process.stdout.write(`trash API listening on http://127.0.0.1:${address.port}\n`);
});

function stop(): void {
  app.server.close(() => { app.store.close(); process.exit(0); });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
