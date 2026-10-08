// Run from the Hawaii UI root with a dev server on port 5187.
// All API requests are mocked; no files or messages reach WXO.
const { chromium } = require('@playwright/test');
const fs = require('fs');
(async()=>{
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1500,height:950}});
 page.setDefaultTimeout(10000);
 page.on('pageerror',e=>console.log('PAGE ERROR',e.message));
 const requests=[];
 const registry=JSON.parse(fs.readFileSync('server/app/registry.json','utf8'));
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/registry')return route.fulfill({json:registry});
  if(path==='/api/uploads')return route.fulfill({json:{files:[{url:'https://example.test/file',fileName:'sample-file'}],extracted_text:'Example document'}});
  if(path==='/api/pending-files')return route.fulfill({json:{ok:true}});
  if(path==='/api/chat'){requests.push(route.request().postDataJSON());return route.fulfill({contentType:'text/event-stream',body:'event: run.started\ndata: {"thread_id":"old-thread"}\n\nevent: run.completed\ndata: {}\n\n'});}
  return route.fulfill({json:{threads:[],messages:[]}});
 });
 await page.goto('http://127.0.0.1:5187');
 console.log('Page loaded');
 await page.getByRole('heading',{name:'Upload documents'}).waitFor();
 const chat=await page.locator('.chat-panel').boundingBox(), panel=await page.locator('.hro-upload-zone').boundingBox();
 if(panel.x<chat.x+chat.width || panel.width!==270 || Math.abs(panel.y-chat.y)>2)throw Error('Incorrect right panel layout '+JSON.stringify({chat,panel}));
 console.log('Layout passed');
 for(let i=0;i<2;i++){
 console.log('Upload cycle',i);
  await page.locator('.hro-drop-target input[accept=".docx"]').setInputFiles({name:'pd.docx',mimeType:'application/octet-stream',buffer:Buffer.from('pd')});
  await page.locator('.hro-drop-target input[accept=".pdf"]').setInputFiles({name:'spec.pdf',mimeType:'application/pdf',buffer:Buffer.from('pdf')});
  await page.getByRole('button',{name:'Classify',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.fe-msg--user').length===1,undefined,{timeout:10000});
  await page.getByRole('button',{name:'Classify',exact:true,disabled:true}).waitFor();
 }
 if(requests.length!==2 || requests.some(r=>r.content!=='Classify PD'||r.thread_id))throw Error('Not fresh requests '+JSON.stringify(requests));
 await page.locator('input[type="file"][multiple]').setInputFiles([
  {name:'next.docx',mimeType:'application/octet-stream',buffer:Buffer.from('pd')},
  {name:'next.pdf',mimeType:'application/pdf',buffer:Buffer.from('pdf')}
 ]);
 await page.waitForFunction(()=>document.querySelectorAll('.fe-msg--user').length===1);
 await page.waitForTimeout(300);
 if(requests.length!==3 || requests[2].thread_id || requests[2].content!=='Classify PD')throw Error('Sidebar did not start fresh');
 await page.screenshot({path:'/private/tmp/hro-desktop.png'});
 await page.setViewportSize({width:700,height:900});
 const dims=await page.evaluate(()=>({w:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
 if(dims.scroll>dims.w)throw Error('Mobile overflow');
 console.log('PASS: compact right panel; three fresh Classify PD requests (panel and sidebar) without old thread IDs; no narrow-screen overflow.');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
