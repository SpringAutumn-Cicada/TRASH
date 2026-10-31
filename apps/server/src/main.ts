import { fileURLToPath } from "node:url";
import { createWorkbenchServer } from "./index.js";

const development = process.argv.includes("--dev");
const requestedPort = Number(process.env.TRASH_PORT ?? "22223");
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error("TRASH_PORT must be an integer from 0 to 65535");

let vite: import("vite").ViteDevServer | undefined;
const app = createWorkbenchServer(development ? {
  frontend: (request, response, next) => {
    if (vite) vite.middlewares(request, response, next);
    else next(new Error("FRONTEND_NOT_READY"));
  }
} : {});

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.closeConnections();
  await vite?.close();
  app.server.close(() => { app.store.close(); });
}

try {
  if (development) {
    const { createServer } = await import("vite");
    vite = await createServer({
      root: fileURLToPath(new URL("../../workbench/", import.meta.url)),
      appType: "spa",
      server: { middlewareMode: true, hmr: { server: app.server } }
    });
  }
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(requestedPort, "127.0.0.1", () => {
      app.server.off("error", reject);
      resolve();
    });
  });
  const address = app.server.address();
  if (address && typeof address !== "string") process.stdout.write(`trash workbench listening on http://127.0.0.1:${address.port}\n`);
  process.on("SIGINT", () => { void stop(); });
  process.on("SIGTERM", () => { void stop(); });
} catch (error) {
  await vite?.close();
  app.server.close();
  app.store.close();
  if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
    process.stderr.write(`端口 ${requestedPort} 已被占用。请停止占用该端口的服务，或设置 TRASH_PORT 后重试。\n`);
  } else process.stderr.write(`${error instanceof Error ? error.message : "启动失败"}\n`);
  process.exitCode = 1;
}
