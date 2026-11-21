import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {migratePdfPreparation,projectLibraryPath,type TrashStore} from '@trash/storage';
import type {PdfFigure,PdfPreparation} from '@trash/protocol';
import {PdfReading} from './pdf-reading.js';
import {planPaperReading} from './paper-reading-plan.js';
const execute=promisify(execFile),VERSION=1;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const fail=(message:string,statusCode=409):never=>{throw Object.assign(new Error(message),{statusCode});};
const instances=new WeakMap<TrashStore,PdfPreparationService>();
type Document=Awaited<ReturnType<PdfReading['document']>>;
export type PreparedPdf={job:PdfPreparation;root:string;document:Document;figures:PdfFigure[];files:Record<string,string>};
export function pdfPreparation(store:TrashStore){let service=instances.get(store);if(!service){service=new PdfPreparationService(store);instances.set(store,service);}return service;}
export class PdfPreparationService {
 private owner=randomUUID();private timer:ReturnType<typeof setInterval>;private running=false;private closed=false;private abort?:AbortController;
 constructor(private store:TrashStore){migratePdfPreparation(store.db);this.timer=setInterval(()=>void this.tick(),1000);this.timer.unref();}
 private source(project:string,source:string){const record=this.store.getSource(source);if(!record||record.project_id!==project)fail('SOURCE_NOT_FOUND',404);const resolved=record!;if(resolved.material_scope==='abstract')fail('PDF_ORIGINAL_NOT_FOUND',404);return resolved;}
 private root(project:string,source:string){this.source(project,source);let path=join(this.store.root,'projects',project);for(const part of projectLibraryPath(path,'literature/parsed/'+source).split('/')){path=join(path,part);if(existsSync(path)&&lstatSync(path).isSymbolicLink())fail('PDF_PATH_INVALID',403);}mkdirSync(path,{recursive:true});return path;}
 private save(job:PdfPreparation){job.updated_at=Date.now();this.store.db.prepare('UPDATE pdf_preparations SET status=?,data=? WHERE id=?').run(job.status,JSON.stringify(job),job.id);}
 status(project:string,source:string){this.source(project,source);return this.store.db.prepare('SELECT data FROM pdf_preparations WHERE project_id=? AND source_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(project,source) as {data:string}|undefined;}
 get(project:string,source:string){const row=this.status(project,source);return row?JSON.parse(row.data) as PdfPreparation:undefined;}
 busy(project:string){return Boolean(this.store.db.prepare("SELECT 1 FROM pdf_preparations WHERE project_id=? AND status IN ('queued','running') LIMIT 1").get(project));}
 enqueue(project:string,source:string,force=false){
  this.source(project,source);const pdf=new PdfReading(this.store).original(project,source);
  if(pdf.bytes.length>50*1024*1024)fail('PDF_FILE_TOO_LARGE',413);
  const fingerprint=hash(JSON.stringify({pdf:pdf.hash,version:VERSION,layout:2,scale:2200}));
  const job=this.store.db.transaction(()=>{
   const active=this.store.db.prepare("SELECT data FROM pdf_preparations WHERE project_id=? AND source_id=? AND status IN ('queued','running')").get(project,source) as {data:string}|undefined;
   if(active)return JSON.parse(active.data) as PdfPreparation;
   if(!force){const row=this.store.db.prepare("SELECT data FROM pdf_preparations WHERE project_id=? AND source_id=? AND fingerprint=? AND status IN ('ready','partial') ORDER BY created_at DESC LIMIT 1").get(project,source,fingerprint) as {data:string}|undefined;
    if(row){const old=JSON.parse(row.data) as PdfPreparation;try{this.load(project,source,old.revision);return old;}catch{/* Rebuild missing or corrupt materials. */}}}
   const at=Date.now();const record:PdfPreparation={id:randomUUID(),project_id:project,source_id:source,pdf_hash:pdf.hash,fingerprint,revision:fingerprint.slice(0,16)+'-'+randomUUID().slice(0,8),status:'queued',phase:'等待分割',completed:0,total:0,warnings:[],created_at:at,updated_at:at};
   this.store.db.prepare('INSERT INTO pdf_preparations(id,project_id,source_id,fingerprint,revision,status,created_at,data) VALUES(?,?,?,?,?,?,?,?)').run(record.id,project,source,fingerprint,record.revision,record.status,at,JSON.stringify(record));return record;
  })();void this.tick();return job;
 }
 auto(project:string,sources:string[]){for(const source of sources){try{this.enqueue(project,source);}catch(error){if(!['PDF_ORIGINAL_NOT_FOUND','SOURCE_NOT_FOUND'].includes((error as Error).message))console.error('PDF preparation enqueue',source,(error as Error).message);}}}
 cancel(project:string,source:string){this.source(project,source);const rows=this.store.db.prepare("SELECT data FROM pdf_preparations WHERE project_id=? AND source_id=? AND status IN ('queued','running')").all(project,source) as {data:string}[];for(const row of rows){const job=JSON.parse(row.data) as PdfPreparation;job.status='cancelled';job.phase='已取消';this.save(job);}return this.get(project,source);}
 private active(job:PdfPreparation){if(this.closed)throw new Error('PDF_PREPARATION_INTERRUPTED');this.source(job.project_id,job.source_id);const row=this.store.db.prepare('SELECT status,owner FROM pdf_preparations WHERE id=?').get(job.id) as {status:string;owner:string}|undefined;if(row?.status!=='running'||row.owner!==this.owner)throw new Error('PDF_PREPARATION_CANCELLED');if(new PdfReading(this.store).original(job.project_id,job.source_id).hash!==job.pdf_hash)throw new Error('PDF_ORIGINAL_CHANGED');}
 private async tick(){if(this.running||this.closed)return;this.running=true;try{
  const record=this.store.db.transaction(()=>{
   this.store.db.prepare("UPDATE pdf_preparations SET status='queued',owner=NULL WHERE status='running' AND lease_until<?").run(Date.now());
   const row=this.store.db.prepare("SELECT id,data FROM pdf_preparations WHERE status='queued' ORDER BY created_at LIMIT 1").get() as {id:string;data:string}|undefined;
   if(!row)return;const job=JSON.parse(row.data) as PdfPreparation;job.status='running';this.store.db.prepare("UPDATE pdf_preparations SET status='running',owner=?,lease_until=?,data=? WHERE id=? AND status='queued'").run(this.owner,Date.now()+90000,JSON.stringify(job),row.id);return job;
  })();if(!record)return;const heartbeat=setInterval(()=>{if(!this.closed)this.store.db.prepare('UPDATE pdf_preparations SET lease_until=? WHERE id=? AND owner=?').run(Date.now()+90000,record.id,this.owner);},15000);heartbeat.unref();this.abort=new AbortController();
  try{await this.prepare(record,this.abort.signal);}catch(error){if(!this.closed){const row=this.store.db.prepare('SELECT status FROM pdf_preparations WHERE id=?').get(record.id) as {status:string}|undefined;if(row?.status==='running'){record.status='failed';record.phase='分割失败';record.error=(error as Error).message;this.save(record);}}}finally{clearInterval(heartbeat);this.abort=undefined;}
 }catch(error){if(!this.closed)console.error('PDF preparation queue',(error as Error).message);}finally{this.running=false;}}
 private async prepare(job:PdfPreparation,signal:AbortSignal){
  this.active(job);const root=this.root(job.project_id,job.source_id),temp=join(root,job.revision+'.pending'),target=join(root,job.revision);mkdirSync(temp,{recursive:true});mkdirSync(join(temp,'pages'),{recursive:true});mkdirSync(join(temp,'figures'),{recursive:true});
  const save=(file:string,data:unknown)=>{const path=join(temp,file);writeFileSync(path+'.tmp',JSON.stringify(data,null,2),{mode:0o600});renameSync(path+'.tmp',path);};
  job.phase='提取文字与章节';this.save(job);const pdf=new PdfReading(this.store),doc=await pdf.document(job.project_id,job.source_id);this.active(job);if(doc.pageCount>500)throw new Error('PDF_PAGE_LIMIT_500');job.total=doc.pageCount;
  const plan=planPaperReading(doc,doc.hash);save('content.json',{...doc,cache:undefined,original:undefined});save('structure.json',{sections:plan.sections,units:plan.units,excluded:plan.excluded,warnings:plan.warnings});
  const figures:PdfFigure[]=[];job.warnings=[...plan.warnings];
  for(const page of doc.pages){this.active(job);if(signal.aborted)throw new Error('PDF_PREPARATION_CANCELLED');job.phase='渲染页面与图表';
   const output=join(temp,'pages',String(page.page).padStart(3,'0')+'.png');if(!existsSync(output)){const rendered=await pdf.page(job.project_id,job.source_id,page.page,2200,doc,signal);copyFileSync(rendered.path,output);}
   const captions=page.lines.filter(line=>/^(?:fig(?:ure)?\.?|table|图|表)\s*([A-Z]?\d+(?:[.-]\d+)*)\s*[.:：\s]/i.test(line.text));
   for(const caption of captions){const match=caption.text.match(/^(fig(?:ure)?\.?|table|图|表)\s*([A-Z]?\d+(?:[.-]\d+)*)/i)!;const type=/table|表/i.test(match[1])?'table':'figure';const id=`${type==='table'?'table':'fig'}-${String(figures.filter(f=>f.type===type).length+1).padStart(2,'0')}`;
    // Intentionally broad candidates: never assert heuristic borders are verified.
    const full=caption.width>page.width*.55||caption.column===0;const x=full?0:caption.x>page.width*.45?page.width*.48:0;const width=full?page.width:page.width*.52;
    const preceding=captions.filter(c=>c.y<caption.y&&Math.abs(c.x-caption.x)<page.width*.2).at(-1);const y=type==='table'?Math.max(0,caption.y-8):Math.max(page.height*.06,preceding?preceding.y+preceding.height+8:page.height*.06);const bottom=type==='table'?page.height*.94:Math.min(page.height,caption.y+caption.height*3+16);
    const region={x,y,width:Math.min(width,page.width-x),height:Math.max(caption.height,bottom-y)};
    const figure:PdfFigure={id,type,number:match[2],caption:caption.text,page:page.page,pages:[page.page],section:plan.units.find(u=>u.lines.includes(caption.id))?.section,region,confidence:.35,warnings:['候选区域，边界与图注连续性未核验；必须结合整页，跨页说明按需补读'],references:[]};
    const ratio=2200/Math.max(page.width,page.height);try{await execute('pdftoppm',['-f',String(page.page),'-l',String(page.page),'-scale-to','2200','-x',String(Math.floor(x*ratio)),'-y',String(Math.floor(y*ratio)),'-W',String(Math.ceil(region.width*ratio)),'-H',String(Math.ceil(region.height*ratio)),'-png','-singlefile',doc.original,join(temp,'figures',id)],{timeout:60000,maxBuffer:1024*1024,signal});figure.path=`figures/${id}.png`;}catch(error){if(signal.aborted)throw error;figure.warnings.push('裁剪失败，使用整页');}
    const token=new RegExp(`(?:fig(?:ure)?\\.?|table|图|表)\\s*${match[2].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![\\d.])`,'i');figure.references=doc.pages.flatMap(p=>p.lines.filter(l=>l.id!==caption.id&&token.test(l.text)).map(l=>({page:p.page,line:l.id})));figures.push(figure);
   }job.completed=page.page;this.save(job);
  }
  if(figures.length)job.warnings.push('图表裁剪为低置信度候选，未验证边界、跨页组合或子图完整性；原页始终可用');
  save('figures/manifest.json',figures);this.active(job);
  const files:Record<string,string>={};for(const file of ['content.json','structure.json','figures/manifest.json',...doc.pages.map(p=>`pages/${String(p.page).padStart(3,'0')}.png`),...figures.flatMap(f=>f.path?[f.path]:[])])files[file]=hash(readFileSync(join(temp,file)));
  job.status=job.warnings.length?'partial':'ready';job.phase=job.status==='partial'?'可分析（存在解析提示）':'分割完成';save('manifest.json',{version:VERSION,job,files,coordinate_system:'PDF.js viewport, top-left, points; rendered longest edge 2200px'});
  this.active(job);if(!existsSync(target))renameSync(temp,target);writeFileSync(join(root,'current.json.tmp'),JSON.stringify({revision:job.revision}));renameSync(join(root,'current.json.tmp'),join(root,'current.json'));this.save(job);
 }
 load(project:string,source:string,revision?:string):PreparedPdf{
  const root=this.root(project,source);const version=revision??JSON.parse(readFileSync(join(root,'current.json'),'utf8')).revision as string;if(!/^[a-f0-9]{16}-[a-f0-9]{8}$/.test(version))fail('PDF_REVISION_INVALID',400);
  const directory=join(root,version);const checked=(file:string)=>{const path=resolve(directory,file);if(!path.startsWith(resolve(directory)+sep))fail('PDF_PATH_INVALID',403);let part=directory;if(lstatSync(part).isSymbolicLink())fail('PDF_PATH_INVALID',403);for(const item of file.split('/')){part=join(part,item);if(lstatSync(part).isSymbolicLink())fail('PDF_PATH_INVALID',403);}return path;};
  const manifest=JSON.parse(readFileSync(checked('manifest.json'),'utf8')) as {job:PdfPreparation;files:Record<string,string>};if(manifest.job.source_id!==source||manifest.job.project_id!==project)fail('PDF_MATERIAL_SCOPE_INVALID',403);
  for(const [file,expected] of Object.entries(manifest.files))if(hash(readFileSync(checked(file)))!==expected)fail('PDF_MATERIAL_CORRUPTED');
  const document=JSON.parse(readFileSync(checked('content.json'),'utf8')) as Document;const original=this.store.artifactFile(project,document.artifact_id);if(!original)fail('PDF_ORIGINAL_NOT_FOUND',404);const resolvedOriginal=original!;document.original=resolvedOriginal.path;document.cache=directory;
  return {job:manifest.job,root:directory,document,figures:JSON.parse(readFileSync(checked('figures/manifest.json'),'utf8')),files:manifest.files};
 }
 async ensure(project:string,source:string,active:()=>boolean,deadline:number,event:(text:string)=>void){const requested=this.enqueue(project,source);event('等待 PDF 分割材料：'+requested.revision);let observed='';while(active()&&Date.now()<deadline&&!this.closed){const row=this.store.db.prepare('SELECT data FROM pdf_preparations WHERE id=?').get(requested.id) as {data:string}|undefined;if(!row)fail('PDF_PREPARATION_MISSING');const resolvedRow=row!;const job=JSON.parse(resolvedRow.data) as PdfPreparation;const progress=`${job.phase} ${job.completed}/${job.total}`;if(progress!==observed){event(progress);observed=progress;}if(['ready','partial'].includes(job.status))return this.load(project,source,job.revision);if(['failed','cancelled'].includes(job.status))throw new Error(job.error??'PDF_PREPARATION_CANCELLED');await new Promise(resolve=>setTimeout(resolve,500));}throw new Error('PDF_MATERIAL_WAIT_INTERRUPTED_OR_TIMEOUT');}
 close(){this.closed=true;clearInterval(this.timer);this.abort?.abort();this.store.db.prepare("UPDATE pdf_preparations SET status='queued',owner=NULL,lease_until=0 WHERE owner=? AND status='running'").run(this.owner);}
}
