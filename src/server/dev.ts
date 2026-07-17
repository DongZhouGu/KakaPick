import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./index.js";

const projectRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

void startServer({
  clientRoot: projectRoot,
  environment: "development",
}).catch(() => {
  console.error("咔咔选开发服务启动失败。");
  process.exitCode = 1;
});
