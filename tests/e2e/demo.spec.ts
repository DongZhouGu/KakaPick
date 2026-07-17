import { expect, test, type Page } from "@playwright/test";
import { warningFixturePath } from "./warning-fixture.js";

const token = "0123456789abcdef".repeat(4);
const port = Number(process.env.BURSTPICK_E2E_PORT ?? 43_110);

async function assertReleaseSurface(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const undersized = await page.locator("button:visible, input:visible, select:visible, textarea:visible, a[href]:visible").evaluateAll((controls) => controls
    .filter((control) => { const rect = control.getBoundingClientRect(); return rect.width < 44 || rect.height < 44; })
    .map((control) => ({ label: control.getAttribute("aria-label") ?? control.textContent, rect: control.getBoundingClientRect().toJSON() })));
  expect(undersized).toEqual([]);
}

test("demo supports immersive independent culling and safe completion", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => { if (["warning", "error"].includes(message.type())) errors.push(`${message.type()}: ${message.text()}`); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/?token=${token}`);
  await expect(page).toHaveURL(`http://127.0.0.1:${port}/`);
  await page.getByRole("button", { name: "体验示例相册" }).click();
  await expect(page.getByText(/示例相册 · 第 1 \/ 3 组/u)).toBeVisible();
  await expect(page.locator(".stage-photo")).toHaveCount(2);
  await expect(page.getByRole("region", { name: "扫描警告" })).toHaveCount(0);
  await assertReleaseSurface(page);

  await page.getByRole("button", { name: "设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("button", { name: "2 张", exact: true })).toHaveAttribute("aria-pressed", "true");
  await settings.getByRole("button", { name: "完成", exact: true }).click();

  await page.getByRole("button", { name: "所有组" }).click();
  await expect(page.getByRole("region", { name: "所有组" })).toBeVisible();
  await expect(page.locator(".group-overview-card")).toHaveCount(3);
  await expect(page.getByText(/示例相册 · 3 组 · 16 张照片/u)).toBeVisible();
  await assertReleaseSurface(page);
  await page.getByRole("button", { name: /第 2 组/u }).click();
  await expect(page.getByText(/示例相册 · 第 2 \/ 3 组/u)).toBeVisible();
  await page.getByRole("button", { name: "所有组" }).click();
  await page.getByRole("button", { name: "返回选片" }).click();
  await page.getByRole("button", { name: "所有组" }).click();
  await page.getByRole("button", { name: /第 1 组/u }).click();
  await expect(page.getByText(/示例相册 · 第 1 \/ 3 组/u)).toBeVisible();

  await page.getByRole("button", { name: "将 DEMO_0001 评为 3 星" }).click();
  await expect(page.getByRole("button", { name: /聚焦 DEMO_0002/u })).toBeVisible();
  await page.getByRole("button", { name: "将 DEMO_0002 评为 4 星" }).click();
  await expect(page.getByRole("button", { name: /聚焦 DEMO_0003/u })).toBeVisible();

  await page.getByRole("button", { name: "设置" }).click();
  await settings.getByRole("button", { name: "1 张", exact: true }).click();
  await expect(page.locator(".stage-photo")).toHaveCount(1);
  await page.getByRole("checkbox", { name: "评分后自动前进" }).uncheck();
  await expect(page.getByRole("slider", { name: "分组范围" })).toBeVisible();
  await settings.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.getByRole("button", { name: /聚焦 DEMO_0003/u })).toBeVisible();

  await page.getByRole("button", { name: /聚焦 DEMO_0003/u }).click();
  await page.keyboard.press("5");
  await page.keyboard.down("Space");
  await expect(page.getByRole("region", { name: /DEMO_0003 100% 查看/u })).toBeVisible();
  await page.keyboard.up("Space");
  await expect(page.getByRole("region", { name: /100% 查看/u })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /聚焦 DEMO_0003/u })).toBeVisible();

  await page.getByRole("button", { name: "导出评分…", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "评分结果" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "3 张入选照片" })).toBeVisible();
  await page.getByRole("button", { name: /写入 Lightroom 评分/u }).click();
  await expect(page.getByText("示例相册不支持写入。")).toBeVisible();
  await page.getByRole("button", { name: "← 返回", exact: true }).click();
  await page.getByRole("button", { name: /复制入选照片/u }).click();
  await page.getByRole("button", { name: "复制到自动生成的精选文件夹", exact: true }).click();
  await expect(page.getByText(/示例预览：\d+ 个文件可复制/u)).toBeVisible();
  await assertReleaseSurface(page);

  await page.getByRole("button", { name: "返回选片" }).click();
  await page.reload();
  await page.getByRole("button", { name: "设置" }).click();
  await expect(settings.getByRole("button", { name: "1 张", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("checkbox", { name: "评分后自动前进" })).not.toBeChecked();
  expect(errors).toEqual([]);
});

test("real scanner fixture renders truthful safe warnings", async ({ page }, testInfo) => {
  const errors: string[] = [];
  const fixturePath = warningFixturePath(testInfo.project.name);
  page.on("console", (message) => { if (["warning", "error"].includes(message.type())) errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/?token=${token}`);
  await page.getByLabel("照片文件夹路径").fill(fixturePath);
  await page.getByRole("button", { name: "打开" }).click();
  const warnings = page.getByRole("region", { name: "扫描警告" });
  await expect(warnings).toBeVisible();
  await expect(warnings).toContainText("重复 RAW");
  await expect(warnings).toContainText("未配对 JPEG");
  await expect(warnings).toContainText("拍摄时间改用文件修改时间");
  await expect(warnings).toContainText(/元数据读取失败|画面相似度分析失败/u);
  await expect(warnings).not.toContainText(fixturePath);
  await assertReleaseSurface(page);
  expect(errors).toEqual([]);
});
