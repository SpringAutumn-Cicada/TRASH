import { expect, test } from "@playwright/test";

test("中文工作台可创建项目、检索原文并在刷新后恢复", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await expect(page).toHaveTitle("trash | 科研工作台");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("heading", { name: "项目" })).toBeVisible();
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByLabel("项目名称").fill("APT 溯源研究测试");
  await page.getByLabel("研究问题").fill("溯源图能否帮助检测横向移动？");
  await page.locator("form").getByRole("button", { name: "创建项目" }).click();
  await expect(page.getByRole("heading", { name: "APT 溯源研究测试" })).toBeVisible();

  await page.getByLabel("导入文献文件").setInputFiles({
    name: "apt-notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Process lineage\n\nA provenance graph can expose lateral movement across host events.")
  });
  await expect(page.getByText("Process lineage", { exact: true })).toBeVisible();
  await page.getByPlaceholder("检索摘要和已导入正文").fill("lateral movement");
  await page.getByRole("button", { name: "检索", exact: true }).click();
  await expect(page.getByText("A provenance graph can expose lateral movement across host events.")).toBeVisible();
  await expect(page.getByText("Process lineage · 第 1 段")).toBeVisible();
  const desktop = await page.screenshot({ path: "test-results/workbench-desktop.png" });
  expect(desktop.byteLength).toBeGreaterThan(10_000);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.reload();
  await expect(page.getByRole("heading", { name: "APT 溯源研究测试" })).toBeVisible();
  await expect(page.getByText("Process lineage", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const mobile = await page.screenshot({ path: "test-results/workbench-mobile.png" });
  expect(mobile.byteLength).toBeGreaterThan(5_000);
});

test("错误提示使用中文且不直接暴露 API 错误码", async ({ page }) => {
  await page.route("**/api/v1/projects", (route) => route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: "INTERNAL_ERROR" })
  }));
  await page.goto("/");
  await expect(page.getByRole("alert")).toHaveText("发生意外错误，请稍后重试。");
  await expect(page.getByText("INTERNAL_ERROR")).toHaveCount(0);
});

test("主题切换即时生效并在刷新后保留，且蓝色主题适配窄屏", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  const theme = page.getByLabel("界面主题");
  await expect(theme).toHaveValue("default");
  expect(await page.locator("html").getAttribute("data-theme")).toBe("default");
  await theme.selectOption("blue");
  await expect(theme).toHaveValue("blue");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "blue");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--green").trim())).toBe("#2563c7");
  await page.reload();
  await expect(page.getByLabel("界面主题")).toHaveValue("blue");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const screenshot = await page.screenshot({ path: "test-results/workbench-blue-mobile.png" });
  expect(screenshot.byteLength).toBeGreaterThan(5_000);
});
