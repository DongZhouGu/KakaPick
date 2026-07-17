import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../src/server/index.js";
import { createWarningFixture, warningFixturePath } from "./warning-fixture.js";

const token = process.env.BURSTPICK_E2E_TOKEN;
if (token === undefined) throw new Error("BURSTPICK_E2E_TOKEN is required");
const port = Number(process.env.BURSTPICK_E2E_PORT ?? 43_110);
const testRoot = await mkdtemp(join(tmpdir(), "burstpick-e2e-runtime-"));
const warningFixtures = ["desktop", "mobile"].map(warningFixturePath);

await Promise.all(warningFixtures.map(createWarningFixture));
const running = await startServer({
  appDataRoot: join(testRoot, "data"),
  cacheRoot: join(testRoot, "cache"),
  clientRoot: join(process.cwd(), "dist", "client"),
  environment: "production",
  installSignalHandlers: false,
  port,
  token,
});

const shutdown = () => {
  void running.close()
    .then(() => Promise.all([
      ...warningFixtures.map((path) => rm(path, { force: true, recursive: true })),
      rm(testRoot, { force: true, recursive: true }),
    ]))
    .finally(() => process.exit());
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
