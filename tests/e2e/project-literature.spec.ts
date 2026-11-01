import { execFileSync } from "node:child_process";
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
  for (const name of ["卡片", "Wiki", "数据", "实验"]) {
    await navigation.getByRole("button", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/[^/]+/${({ 卡片: "cards", Wiki: "wiki", 数据: "data", 实验: "experiments" })[name]}$`));
  }
  await navigation.getByRole('button',{name:'数据',exact:true}).click();
  await page.getByRole('tab',{name:'实验数据',exact:true}).click();
  await page.getByRole('button',{name:'新建实验记录',exact:true}).first().click();
  const editor=page.locator('.knowledge-editor').first();
  await editor.getByRole('button',{name:'高级 JSON',exact:true}).click();
  const json=editor.getByLabel('结构化内容 JSON');
  const content=JSON.parse(await json.inputValue());content.title='未保存的实验记录';await json.fill(JSON.stringify(content));
  await editor.getByRole('button',{name:'关闭',exact:true}).click();
  const discard=page.getByRole('dialog',{name:'放弃未保存的修改？'});
  await expect(discard).toBeVisible();await discard.getByRole('button',{name:'放弃修改并继续',exact:true}).click();
  await expect(editor).toHaveCount(0);
  await navigation.getByRole('button',{name:'实验',exact:true}).click();
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
  await page.getByRole("button", { name: "导入源代码", exact: true }).first().click();
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


test("文献复现可导入多份 ZIP、切换预览并确认移除", async ({page,request})=>{
  const response=await request.post("/api/v1/projects",{data:{title:"复现列表测试",research_question:"多论文代码"}});
  expect(response.status()).toBe(201);
  const {project}=await response.json();
  await page.goto(`/projects/${project.project_id}/reproductions`);
  const archive=execFileSync("python3",["-c","import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w') as z:z.writestr('README.md','fixture preview')\nsys.stdout.buffer.write(b.getvalue())"]);
  for(const name of ["论文甲","论文乙"]){
    await page.getByRole("button",{name:"源代码",exact:true}).first().click();
    const importButton=page.getByRole("button",{name:"导入源代码",exact:true});if(!(await page.getByRole("dialog",{name:"添加复现代码"}).isVisible()))await importButton.first().click();
    const dialog=page.getByRole("dialog",{name:"添加复现代码"});
    await dialog.getByLabel("选择复现代码 ZIP 文件").setInputFiles({name:`${name}.zip`,mimeType:"application/zip",buffer:archive});
    await dialog.getByRole("button",{name:"保存",exact:true}).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("heading",{name,exact:true})).toBeVisible();
  }
  const list=page.getByRole("navigation",{name:"已导入的论文代码"});
  await expect(list.getByRole("button")).toHaveCount(2);
  await list.getByRole("button",{name:/论文甲/}).click();
  await expect(page.getByRole("heading",{name:"论文甲",exact:true})).toBeVisible();
  const report={id:'env_fixture',created_at:new Date().toISOString(),skill_version:'2.6.0',code_fingerprint:'a'.repeat(64),content:{schema_version:2,adaptation:{status:'ready'},code_information:{datasets:[],run_plans:[{name:'fixture',execution:{mode:'train',processing_method:'batch',dataset_runs:[]}}]}}};
  await page.route('**/reproductions/*/environment',route=>route.fulfill({json:{tasks:[],reports:[report]}}));
  await page.getByRole('button',{name:'跑实验',exact:true}).click();
  await page.getByRole('combobox',{name:/^处理方式/}).selectOption('entity');
  await page.getByRole('combobox',{name:/^权重模式/}).selectOption('evaluate');
  await page.reload();
  await page.getByRole('button',{name:'跑实验',exact:true}).click();
  await expect(page.getByRole('combobox',{name:/^处理方式/})).toHaveValue('entity');
  await expect(page.getByRole('combobox',{name:/^权重模式/})).toHaveValue('evaluate');
  await page.getByRole("button",{name:"浏览代码",exact:true}).click();
  await page.getByRole("button",{name:/README.md/}).click();
  await expect(page.getByText("fixture preview",{exact:true})).toBeVisible();
  await page.route('**/ssh-profiles',route=>route.fulfill({json:{profiles:[{profile_id:'host',name:'本地测试主机',host:'fixture.invalid',port:22,username:'root',auth:'password'}]}}));
  await page.route('**/remote-workspace?*',route=>route.fulfill({json:{workspace:{root:'/root/project'}}}));
  await page.route('**/freshness',route=>route.fulfill({json:{stale:false}}));
  await page.route('**/api/v1/projects/*/reproductions',async route=>{const response=await route.fetch();const body=await response.json();if(body.codes)for(const code of body.codes)code.uploads=[{profile_id:'host',path:'/root/project/reproductions/'+code.name,sha256:'b'.repeat(64),at:new Date().toISOString()}];await route.fulfill({json:body});});
  await page.reload();
  await page.getByRole('button',{name:'源代码',exact:true}).last().click();
  await expect(page.getByRole('button',{name:'开始分析',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'上传到 AutoDL',exact:true}).click();
  const upload=page.getByRole('dialog',{name:'上传到 AutoDL',exact:true});
  await expect(upload.getByText('最近一次上传记录',{exact:true})).toBeVisible();
  await expect(upload.getByRole('button',{name:'重新上传',exact:true})).toBeVisible();
  await upload.getByText('查看 SHA-256',{exact:true}).click();
  await expect(upload.getByText('b'.repeat(64),{exact:true})).toBeVisible();
  await upload.getByRole('button',{name:'关闭上传弹窗',exact:true}).click();
  await page.getByRole("button",{name:"移除复现代码记录"}).click();
  const confirmation=page.getByRole("dialog",{name:"移除复现代码",exact:true});
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button",{name:"确认移除",exact:true}).click();
  await expect(confirmation).toHaveCount(0);
  await expect(list.getByRole("button")).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(list.getByRole("button")).toHaveCount(1);
});
