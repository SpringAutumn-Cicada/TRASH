import {expect,test} from '@playwright/test';
import {samplePdf} from '../fixtures/pdf.js';
test('original PDF viewer preserves image page, navigation, search, thumbnails and hash references',async({page,request})=>{
 const created=await request.post('/api/v1/projects',{data:{title:'PDF验收隔离项目',research_question:'Verify visual PDF reading'}});expect(created.status()).toBe(201);const {project}=await created.json();
 const uploaded=await request.post(`/api/v1/projects/${project.project_id}/sources/files?filename=acceptance.pdf`,{data:samplePdf(),headers:{'content-type':'application/pdf'}});expect(uploaded.status()).toBe(201);const {sources}=await uploaded.json(),source=sources[0];
 const metadata=await request.get(`/api/v1/projects/${project.project_id}/sources/${source.source_id}/pdf`);expect(metadata.status()).toBe(200);const info=await metadata.json();expect(info.pageCount).toBe(2);expect(info.pages[1].text).toBe('');
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`/api/v1/projects/${project.project_id}/sources/${source.source_id}/pdf-view?hash=${info.hash}#page=2`);await page.waitForLoadState('networkidle');
 await expect(page.getByRole('spinbutton',{name:'PDF 页序'})).toHaveValue('2');await expect(page.locator('canvas').first()).toBeVisible();
 await page.getByRole('button',{name:'上一页',exact:true}).click();await expect(page.getByRole('spinbutton',{name:'PDF 页序'})).toHaveValue('1');
 const width=await page.locator('canvas').first().evaluate(canvas=>canvas.getBoundingClientRect().width);await page.getByRole('button',{name:'放大',exact:true}).click();await expect.poll(()=>page.locator('canvas').first().evaluate(canvas=>canvas.getBoundingClientRect().width)).toBeGreaterThan(width);
 await page.getByRole('button',{name:'适合宽度',exact:true}).click();await page.getByRole('textbox',{name:'搜索 PDF 文字'}).fill('acceptance');await page.getByRole('button',{name:'查找下一个',exact:true}).click();await expect(page.locator('.pdf-reader-search')).toContainText('1/1');
 await page.getByRole('button',{name:'目录/缩略图'}).click();await expect(page.locator('.pdf-reader-sidebar img')).toHaveCount(2);await expect.poll(()=>page.locator('.pdf-reader-sidebar img').last().evaluate(image=>(image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
 await page.getByRole('button',{name:'旋转',exact:true}).click();expect(errors).toEqual([]);
 await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.goto(`/pdf-reader?project=${project.project_id}&source=${source.source_id}&hash=wrong#page=2`);await expect(page.getByRole('alert')).toContainText('版本已变化');
});
