import { expect, test } from "@playwright/test";

test("项目功能导航不误报未保存，实验五页签可用，删除无需填写项目全名", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目", exact: true }).first().click();
  await page.getByLabel("项目名称").fill("实验导航与删除测试");
  await page.getByLabel("研究问题").fill("验证实验与项目导航的完整流程");
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(page.getByRole("heading", { name: "实验导航与删除测试" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "项目功能" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "研究项目" })).toHaveCount(0);
  await page.getByRole("button", { name: "返回项目列表", exact: true }).click();
  await expect(page.getByRole("heading", { name: "实验导航与删除测试" })).toBeVisible();
  await page.getByRole("navigation", { name: "研究项目" }).getByRole("button", { name: "实验导航与删除测试", exact: true }).click();
  const dialogs: string[] = [];
  page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  const navigation = page.getByRole("navigation", { name: "项目功能" });
  for (const name of ["卡片", "Wiki", "实验结果", "任务", "实验"]) {
    await navigation.getByRole("button", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/[^/]+/${({ 卡片: "cards", Wiki: "wiki", 实验结果: "results", 任务: "tasks", 实验: "experiments" })[name]}$`));
  }
  const experimentNavigation = page.getByRole("navigation", { name: "实验功能" });
  for (const name of ["实验概览", "实验代码", "实验计划", "运行", "产物"]) {
    await experimentNavigation.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
  await experimentNavigation.getByRole("button", { name: "实验概览", exact: true }).click();
  await page.getByRole("button", { name: "浏览目录", exact: true }).click();
  const directory = page.getByRole("dialog", { name: "选择仓库目录" });
  await expect(directory).toBeVisible();
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  await directory.getByRole("button", { name: "关闭目录选择" }).click();
  await navigation.getByRole("button", { name: "文献复现", exact: true }).click();
  await page.getByRole("button", { name: "添加复现代码", exact: true }).first().click();
  const reproduction = page.getByRole("dialog", { name: "添加复现代码" });
  await expect(reproduction).toBeVisible();
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  await reproduction.getByRole("button", { name: "关闭复现代码弹窗" }).click();
  await navigation.getByRole("button", { name: "AutoDL 工作区", exact: true }).click();
  for (const name of ["AutoDL 信息", "AutoDL 工作区"]) {
    await page.getByRole("navigation", { name: "AutoDL 功能" }).getByRole("button", {name, exact:true}).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
  expect(dialogs).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "项目操作" }).click();
  await page.getByRole("button", { name: "删除项目", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "删除项目" });
  await expect(confirmation.getByRole("textbox")).toHaveCount(0);
  await confirmation.getByRole("button", { name: "确认永久删除" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "实验导航与删除测试" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "实验导航与删除测试" })).toHaveCount(0);
});

test("中文工作台可创建项目、检索原文并在刷新后恢复", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await expect(page).toHaveTitle("trash | 科研工作台");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("navigation", { name: "研究项目" })).toBeVisible();
  await page.getByRole("button", { name: "新建项目", exact: true }).first().click();
  await page.getByLabel("项目名称").fill("APT 溯源研究测试");
  await page.getByLabel("研究问题").fill("溯源图能否帮助检测横向移动？");
  await page.locator("form").getByRole("button", { name: "创建项目" }).click();
  await expect(page.getByRole("heading", { name: "APT 溯源研究测试" })).toBeVisible();

  await page.getByRole("navigation", { name: "项目功能" }).getByRole("button", { name: "文献", exact: true }).click();
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
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth ? [] : Array.from(document.querySelectorAll("body *")).filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => `${e.tagName}.${e.className}:${Math.round(e.getBoundingClientRect().right)}`))).toEqual([]);

  await page.reload();
  await expect(page.getByRole("heading", { name: "APT 溯源研究测试" })).toBeVisible();
  await expect(page.getByText("Process lineage", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth ? [] : Array.from(document.querySelectorAll("body *")).filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => `${e.tagName}.${e.className}:${Math.round(e.getBoundingClientRect().right)}`))).toEqual([]);
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
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth ? [] : Array.from(document.querySelectorAll("body *")).filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => `${e.tagName}.${e.className}:${Math.round(e.getBoundingClientRect().right)}`))).toEqual([]);
  const screenshot = await page.screenshot({ path: "test-results/workbench-blue-mobile.png" });
  expect(screenshot.byteLength).toBeGreaterThan(5_000);
});


test("两层导航可收起为图标栏并恢复偏好，窄屏作为抽屉展开", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "研究项目" })).toBeVisible();
  await page.getByRole("button", { name: "隐藏导航", exact: true }).first().click();
  await expect(page.locator(".project-sidebar.compact")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "研究项目" })).toBeVisible();
  await page.reload();
  await expect(page.locator(".workspace-header").getByRole("button", { name: "展开导航", exact: true })).toBeVisible();
  await page.locator(".workspace-header").getByRole("button", { name: "展开导航", exact: true }).click();
  await expect(page.getByLabel("搜索项目", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("navigation", { name: "研究项目" })).toHaveCount(0);
  await page.locator(".workspace-header").getByRole("button", { name: "展开导航", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "项目导航" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "项目导航" })).toHaveCount(0);
  await expect(page.locator(".workspace-header").getByRole("button", { name: "展开导航", exact: true })).toBeFocused();
});
