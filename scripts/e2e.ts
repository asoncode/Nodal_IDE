import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { ChatSession } from '../packages/shared/src/chat.js';
import { preview } from 'vite';
import { Store } from '../packages/persistence/src/index.js';
import { NodalService } from '../packages/runtime/src/service.js';
import { startServer } from '../packages/runtime/src/server.js';
import { git } from '../packages/workspace/src/index.js';

// All browser operations go through gstack's persistent Playwright-backed browse CLI.
const candidates = [process.env.NODAL_BROWSE_BIN, join(homedir(),'.agents/skills/gstack/browse/dist/browse'), join(homedir(),'.Codex/skills/gstack/browse/dist/browse')].filter(Boolean) as string[];
let binary = '';
for (const candidate of candidates) { try { await access(candidate); binary = candidate; break; } catch { /* Try next installed skill path. */ } }
if (!binary) throw new Error('Install the gstack browse skill or set NODAL_BROWSE_BIN to its executable. See docs/TESTING.md.');
async function browse(...args: string[]): Promise<string> {
  return new Promise((resolveResult,reject) => {
    const child = spawn(binary,args,{stdio:['ignore','pipe','pipe'],shell:false});
    let output='',error=''; child.stdout.on('data',chunk=>output+=String(chunk)); child.stderr.on('data',chunk=>error+=String(chunk));
    child.on('error',reject); child.on('exit',code=>code===0?resolveResult(output):reject(new Error(`Browser ${args[0]} ${args[0] === "goto" ? "[launch URL]" : args[1] ?? ""} failed: ${error || output}`)));
  });
}
async function eventually(check:()=>Promise<boolean>, message:string, timeout=20000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) { if(await check()) return; await new Promise(r=>setTimeout(r,120)); }
  throw new Error(message);
}
// gstack permits uploads from /tmp and the workspace; macOS Node defaults to /var/folders.
const temp=await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(),'nodal-ui-'));
const repo=join(temp,'project'), data=join(temp,'data'); await mkdir(repo);
await mkdir(join(repo,'src'));
await writeFile(join(repo,'index.js'),'export const answer = 42;\n');
for(const args of [['init','-b','main'],['add','--','.'],['-c','user.name=Nodal Test','-c','user.email=test@localhost','commit','-m','Initial']]) {
  const result=await git(repo,args); assert.equal(result.exitCode,0,result.stderr);
}
const store=new Store(join(data,'nodal.sqlite'));
const service=new NodalService(store,data);
const runtime=await startServer(service,{origins:['http://127.0.0.1:5174']});
const vite=await preview({configFile:'apps/desktop/vite.config.ts',preview:{host:'127.0.0.1',port:5174,strictPort:true}});
try {
  await browse('viewport','1500x960');
  await browse('goto',`http://127.0.0.1:5174/?test=${Date.now()}#token=${runtime.token}&port=${new URL(runtime.url).port}`);
  await eventually(async()=> (await browse('text')).includes('Local runtime connected'),'Runtime bootstrap failed',40000);
  // The shared browser may retain a previous preview whose runtime has already stopped.
  await browse('console','--clear');
  await browse('click','.view-title button[aria-label="Open Folder"]');
  await browse('wait','[role="dialog"]');
  await browse('fill','input[placeholder="/Users/you/projects/my-app"]',repo);
  await eventually(async()=> (await browse('js','document.querySelector(".dialog-actions .primary")?.disabled')).trim() === 'false','Repository submit stayed disabled');
  await browse('click','.dialog-actions .primary');
  await eventually(async()=> (await browse('text')).includes('index.js'),`Repository explorer did not load. Browser: ${await browse('text')}`);
  const project=store.projects()[0]; assert(project);
  console.log('PASS open repository and inspect files');

  await browse('click','button[aria-label="Workflows"]');
  await browse('click','.sidebar-item:has-text("Local command")');
  await browse('click','.react-flow__node[data-id="command"]');
  await browse('fill','label.field:has-text("Name") input','Approved version check');
  await browse('fill','label.field:has-text("Executable") input',process.execPath);
  await browse('click','button[aria-label="Add node"]');
  await browse('click','.quick-pick-list button:has-text("Human approval")');
  await browse('fill','label.field:has-text("Name") input','Review command evidence');
  const ids = JSON.parse(await browse('js','Array.from(document.querySelectorAll(".react-flow__node")).map(node=>node.getAttribute("data-id"))')) as string[];
  const approvalId = ids.find(nodeId => !['start','command','end'].includes(nodeId)); assert(approvalId);
  await browse('click',`.react-flow__node[data-id="${approvalId}"]`);
  await browse('press','ArrowRight');
  // Dispatch the SVG click through React Flow's public DOM handler; straight paths have zero-height click boxes.
  await browse('js',`document.querySelector('.react-flow__edge[data-id="command-end-out"]').dispatchEvent(new MouseEvent("click",{bubbles:true}))`);
  await browse('click','button:has-text("Delete connection")');
  await browse('click','.react-flow__handle.source[data-nodeid="command"]');
  await browse('click',`.react-flow__handle.target[data-nodeid="${approvalId}"]`);
  await browse('click',`.react-flow__handle.source[data-nodeid="${approvalId}"]`);
  await browse('click','.react-flow__handle.target[data-nodeid="end"]');
  await browse('click','.command-actions button[aria-label="Save"]');
  await eventually(async()=>store.graphs(project.id).length===1,'Graph was not persisted');
  assert.equal(store.graphs(project.id)[0].nodes.find(n=>n.id==='command')?.label,'Approved version check');
  assert.equal(store.graphs(project.id)[0].nodes.length,4); assert.equal(store.graphs(project.id)[0].edges.length,3);
  assert((store.graphs(project.id)[0].nodes.find(node=>node.id===approvalId)?.position.x ?? 0)>100);
  console.log('PASS node add, keyboard move, port connections, configuration, and save');

  await browse('click','.run-button');
  await eventually(async()=>store.runs(project.id).length===1,'Run did not start');
  const runId=store.runs(project.id)[0].id;
  await eventually(async()=>store.approvals(runId).some(a=>a.decision==='pending'),'Command permission was not durable');
  await browse('click','.panel-tabs button:has-text("Approvals")');
  await eventually(async()=> (await browse('text')).includes('not an OS sandbox'),'Command trust boundary not visible');
  await browse('click','.approval-item .primary');
  await eventually(async()=>store.approvals(runId).some(a=>a.nodeId===approvalId && a.decision==='pending'),'Human gate did not block durably');
  await eventually(async()=> (await browse('text')).includes('Review the results before continuing'),'Human gate not visible');
  await browse('click','.approval-item .primary');
  await eventually(async()=>store.run(runId).status==='succeeded','Approved command and human gate did not complete');
  await browse('click','.panel-tabs button:has-text("Console")');
  await eventually(async()=> (await browse('text')).includes(process.version),'Real command output not visible');
  assert(store.events(runId).some(e=>e.kind==='command.output'));
  console.log('PASS durable approval, real process, streaming output, persisted run');

  await browse('click','button[aria-label="Explorer"]');
  await browse('click','.file-tree button[title="index.js"]');
  await browse('click','.monaco-editor .view-lines');
  await browse('press',process.platform==='darwin'?'Meta+A':'Control+A');
  const edited='export const answer = 43; // saved through Monaco';
  await browse('type',edited);
  await browse('click','.command-actions button[aria-label="Save"]');
  await eventually(async()=> (await readFile(join(repo,'index.js'),'utf8'))===edited,'Monaco save changed or lost typed bytes');
  await browse('click','button[aria-label="Source control"]');
  await eventually(async()=> (await browse('text')).includes('+export const answer = 43'),'Git diff not visible');
  console.log('PASS Monaco edit/save with exact disk bytes and Git diff inspection');

  await browse('click','button[aria-label="New File"]');
  await browse('fill','input[aria-label="New file path"]','src/main.cpp');
  await browse('press','Enter');
  await eventually(async()=> (await readFile(join(repo,'src/main.cpp'),'utf8').catch(()=>undefined))==='','Explorer did not create an empty file');
  await browse('wait','.file-tree button[title="src/main.cpp"]');
  await browse('wait','.editor-tab.active:has-text("main.cpp")');
  await browse('click','.monaco-editor .view-lines');
  const createdContent='int main() { return 0; }';
  await browse('type',createdContent);
  await browse('click','.command-actions button[aria-label="Save"]');
  await eventually(async()=> (await readFile(join(repo,'src/main.cpp'),'utf8'))===createdContent,'New file did not save through Monaco');
  console.log('PASS Explorer file creation in an existing folder, automatic editor opening, and exact saved bytes');

  await browse('click','button[aria-label="Actions for src/main.cpp"]');
  await browse('click','.explorer-menu button:has-text("Rename file")');
  await browse('fill','input[aria-label="Rename file path"]','src/engine.cpp');
  await browse('press','Enter');
  await eventually(async()=> (await readFile(join(repo,'src/engine.cpp'),'utf8').catch(()=>undefined))===createdContent,'Rename did not preserve file bytes');
  await assert.rejects(readFile(join(repo,'src/main.cpp')), {code:'ENOENT'});
  await browse('wait','.editor-tab.active:has-text("engine.cpp")');
  await browse('click','button[aria-label="Actions for src/engine.cpp"]');
  await browse('click','.explorer-menu button:has-text("Duplicate saved file")');
  await browse('fill','input[aria-label="Duplicate file path"]','src/copy.cpp');
  await browse('press','Enter');
  await eventually(async()=> (await readFile(join(repo,'src/copy.cpp'),'utf8').catch(()=>undefined))===createdContent,'Duplicate did not copy the saved file');
  await browse('click','button[aria-label="Actions for src/copy.cpp"]');
  await browse('click','.explorer-menu button:has-text("Delete file")');
  await browse('click','.explorer-confirm button:has-text("Delete file")');
  await eventually(async()=> (await readFile(join(repo,'src/copy.cpp'),'utf8').catch(()=>undefined))===undefined,'Delete did not remove file');
  await browse('click','button[aria-label="Deleted files"]');
  await browse('wait','button[aria-label="Restore src/copy.cpp"]');
  await browse('click','button[aria-label="Restore src/copy.cpp"]');
  await eventually(async()=> (await readFile(join(repo,'src/copy.cpp'),'utf8').catch(()=>undefined))===createdContent,'Trash restore lost file content');
  await browse('click','button[aria-label="Close deleted files"]');
  await browse('click','button[aria-label="New Folder"]');
  await browse('fill','input[aria-label="New folder path"]','notes');
  await browse('press','Enter');
  await browse('wait','.file-tree button[aria-label="notes"]');
  await browse('click','button[aria-label="New File"]');
  await browse('fill','input[aria-label="New file path"]','notes/tactics.md');
  await browse('press','Enter');
  await browse('wait','.editor-tab.active:has-text("tactics.md")');
  await browse('click','.monaco-editor .view-lines');
  await browse('type','# Match plan');
  await browse('click','.command-actions button[aria-label="Save"]');
  await eventually(async()=> (await readFile(join(repo,'notes/tactics.md'),'utf8'))==='# Match plan','New folder file save failed');
  console.log('PASS rename, duplicate, recoverable delete/restore, empty folder creation, nested file editing');

  await browse('press',process.platform==='darwin'?'Meta+Shift+F':'Control+Shift+F');
  await browse('fill','input[aria-label="Search repository"]','return');
  await browse('press','Enter');
  await browse('wait','.search-result:has-text("src/engine.cpp:1")');
  await browse('click','.search-result:has-text("src/engine.cpp:1")');
  await browse('wait','.editor-tab.active:has-text("engine.cpp")');
  await browse('press',process.platform==='darwin'?'Meta+P':'Control+P');
  await browse('fill','input[aria-label="Quick Open"]','tactics');
  await browse('press','Enter');
  await browse('wait','.editor-tab.active:has-text("tactics.md")');
  const wrappedBefore=(await browse('js', `document.querySelector('button[aria-label="Word wrap"]').getAttribute('aria-pressed')`)).trim();
  await browse('press',process.platform==='darwin'?'Meta+Shift+P':'Control+Shift+P');
  await browse('fill','input[aria-label="Command Palette"]','Toggle Word Wrap');
  await browse('press','Enter');
  assert.notEqual((await browse('js', `document.querySelector('button[aria-label="Word wrap"]').getAttribute('aria-pressed')`)).trim(),wrappedBefore,'Word wrap command failed');
  await browse('click','button[aria-label="Editor settings"]');
  await browse('select','select[aria-label="Editor font size"]','15');
  assert.equal((await browse('js', 'JSON.parse(localStorage.getItem("nodal.editor.settings.v1")).fontSize')).trim(),'15','Editor preference was not persisted');
  await browse('click','.editor-preferences button:has-text("Done")');
  await browse('click','.code-tools button:has-text("Find")');
  await browse('wait','.monaco-editor .find-widget.visible');
  await browse('press','Escape');
  console.log('PASS repository search and result navigation, keyboard Quick Open/Command Palette, word wrap, saved preferences, Monaco Find');
  await browse('click','button[aria-label="Explorer"]');
  await browse('click','button[aria-label="New File"]');
  await browse('fill','input[aria-label="New file path"]','notes/config.json');
  await browse('press','Enter');
  await browse('wait','.editor-tab.active:has-text("config.json")');
  await browse('click','.monaco-editor .view-lines');
  await browse('type','{"team":"Arsenal","shape":[4,4,2]}');
  await browse('click','.code-tools button:has-text("Format")');
  await eventually(async()=>Number((await browse('js','document.querySelectorAll(".monaco-editor .view-line").length')).trim())>2,'Bundled JSON formatter did not format the document');
  await browse('click','.command-actions button[aria-label="Save"]');
  await eventually(async()=> (await readFile(join(repo,'notes/config.json'),'utf8').catch(()=>'' )).includes('\n'),'Formatted JSON did not save');
  assert.deepEqual(JSON.parse(await readFile(join(repo,'notes/config.json'),'utf8')),{team:'Arsenal',shape:[4,4,2]});
  await mkdir('docs/screenshots',{recursive:true});
  await browse('screenshot',resolve('docs/screenshots/editor.png'));
  await browse('click','.file-tree button[aria-label="src/engine.cpp"]');
  await browse('click','.monaco-editor .view-lines');
  await browse('press',process.platform==='darwin'?'Meta+A':'Control+A');
  await browse('type','discarded editor fixture');
  await browse('click','.file-tree button[aria-label="src/copy.cpp"]');
  await browse('dialog-accept');
  await browse('click','button[aria-label="Close src/engine.cpp"]');
  await browse('press',process.platform==='darwin'?'Meta+P':'Control+P');
  await browse('fill','input[aria-label="Quick Open"]','src/engine.cpp');
  await browse('press','Enter');
  await browse('wait','.editor-tab.active:has-text("engine.cpp")');
  const reopenedText=await browse('js','document.querySelector(".monaco-editor .view-lines").textContent');
  assert(!reopenedText.includes('discarded editor fixture'),'Discarded Monaco text reappeared after reopening');
  assert(reopenedText.includes('return'),'Reopened editor did not display the saved file');
  console.log('PASS real JSON formatting/save and same-content editor close/reopen regression');



  await browse('click','.editor-tab[data-tab="replay"] button');
  await eventually(async()=> (await browse('text')).includes('run › completed'),'Historical run events not visible');
  assert.equal(store.runs(project.id).length,1,'Replay started an unexpected run');
  await browse('click','.editor-tab[data-tab="graph"] button');
  await browse('click','.command-actions button[aria-label="Save"]');
  const saved=store.graphs(project.id)[0]; assert.equal(saved.nodes.length,4); assert.equal(saved.edges.length,3);
  await mkdir('docs/screenshots',{recursive:true});
  await browse('screenshot',resolve('docs/screenshots/nodal.png'));
  // Explicitly seeded history exercises the real chat API and renderer without a paid model request.
  const chat = await service.dispatch('createChat', { projectId: project.id, provider: 'claude', permission: 'read-only' }) as ChatSession;
  store.saveChatTurn({ id: 'browser-chat-fixture', chatId: chat.id, message: 'Fixture: explain this repository', output: 'Fixture response: this repository exports an answer.', status: 'succeeded', createdAt: new Date().toISOString() });
  await browse('click', 'button[aria-label="Agent chat"]');
  await browse('wait', 'select[aria-label="Chat history"]');
  await eventually(async () => (await browse('text')).includes('New Claude chat'), 'Chat history did not load');
  await browse('select', 'select[aria-label="Chat history"]', chat.id);
  await eventually(async () => (await browse('text')).includes('Fixture response: this repository exports an answer.'), 'Saved chat response did not load');
  await browse('click', 'button[aria-label="New chat"]');
  await browse('select', 'select[aria-label="Chat provider"]', 'codex');
  await browse('select', 'select[aria-label="Chat access"]', 'scoped-edit');
  await browse('fill', 'textarea[aria-label="Message agent"]', 'Draft only: review this project');
  await eventually(async () => (await browse('js', 'document.querySelector(".chat-compose-actions .primary")?.disabled')).trim() === 'false', 'Chat composer stayed disabled');
  await browse('type', ' @index');
  await browse('wait', '[role="option"]:has-text("index.js")');
  await browse('press', 'Enter');
  await browse('wait', 'button[aria-label="Remove index.js"]');
  const upload = join(temp, 'brief.md'); await writeFile(upload, '# Brief\nKeep changes scoped.');
  await browse('upload', 'input[aria-label="Upload chat files"]', upload);
  await browse('wait', 'button[aria-label="Remove brief.md"]');
  await browse('click', 'button[aria-label="Remove brief.md"]');
  await browse('upload', 'input[aria-label="Upload chat files"]', upload);
  await browse('wait', 'button[aria-label="Remove brief.md"]');
  assert.equal(store.chats(project.id).length, 1, 'Draft unexpectedly created a provider session');
  await browse('screenshot', resolve('docs/screenshots/chat.png'));
  await browse('viewport', '1000x650');
  assert.equal((await browse('js', 'document.documentElement.scrollWidth <= window.innerWidth')).trim(), 'true', 'Chat overflows the minimum window width');
  assert.equal((await browse('js', 'document.querySelector(".chat-compose-actions .primary").getBoundingClientRect().bottom <= window.innerHeight - 22')).trim(), 'true', 'Chat send button is hidden at the minimum window height');
  await browse('viewport', '1500x960');
  console.log('PASS saved chat history, provider/access controls, @ references, uploads/removal, draft consent, minimum window size (seeded fixture, no model request)');
  await browse('click', 'button[aria-label="Close chat"]');
  await browse('click', '.panel-tabs button:has-text("Terminal")');
  await browse('click', '.terminal-actions button[aria-label="New terminal"]');
  await browse('wait', '.xterm-screen');
  await browse('click', '.terminal-view .xterm-screen');
  // Build the marker at runtime so echoed input cannot satisfy the output assertion.
  await browse('type', `unset HISTFILE; pwd; node -p "['NODAL','TERMINAL','OK'].join('_')"`);
  await browse('press', 'Enter');
  await eventually(async () => (await browse('text')).includes('NODAL_TERMINAL_OK'), 'Real shell output was not rendered');
  assert.equal((await browse('js', 'document.documentElement.scrollWidth <= window.innerWidth')).trim(), 'true', 'Terminal expands the workspace beyond the window');
  assert((await browse('text')).includes(project.root), 'Terminal did not start in the open repository');
  await browse('type', `node -e "setInterval(()=>{},1000)"`);
  await browse('press', 'Enter');
  await browse('press', 'Control+C');
  await browse('type', `node -p "['INTERRUPT','OK'].join('_')"`);
  await browse('press', 'Enter');
  await eventually(async () => (await browse('text')).includes('INTERRUPT_OK'), 'Ctrl+C did not return control to the shell');
  const firstTab = (await browse('js', 'document.querySelector(".terminal-tabs [role=tab]").id')).trim();
  await browse('click', '.terminal-actions button[aria-label="New terminal"]');
  await eventually(async () => (await browse('js', 'document.querySelectorAll(".terminal-tabs [role=tab]").length')).trim() === '2', 'Second terminal tab did not open');
  await browse('click', `#${firstTab}`);
  await browse('press', 'Control+Backquote');
  assert.equal((await browse('is', 'visible', '.terminal-panel')).trim(), 'false', 'Terminal shortcut did not hide the panel');
  await browse('press', 'Control+Backquote');
  assert.equal((await browse('is', 'visible', '.terminal-panel')).trim(), 'true', 'Terminal shortcut did not reopen the panel');
  assert.equal((await browse('js', 'document.querySelectorAll(".terminal-tabs [role=tab]").length')).trim(), '2', 'Hiding the panel discarded terminal tabs');
  await browse('screenshot', resolve('docs/screenshots/terminal.png'));
  await browse('click', '.terminal-actions button[aria-label="Kill terminal"]');
  await eventually(async () => (await browse('js', 'document.querySelectorAll(".terminal-tabs [role=tab]").length')).trim() === '1', 'First terminal did not close');
  await browse('click', '.terminal-actions button[aria-label="Kill terminal"]');
  await eventually(async () => (await browse('js', 'document.querySelectorAll(".terminal-tabs [role=tab]").length')).trim() === '0', 'Last terminal did not close');
  console.log('PASS real terminal cwd/output, Ctrl+C, multiple tabs, shortcut hide/reopen, and terminal cleanup');
  const errors=await browse('console','--errors');
  assert(errors.includes('no console errors'),errors);
  console.log('PASS offline replay, graph round-trip, no browser errors; screenshot docs/screenshots/nodal.png');
} finally {
  await new Promise<void>((resolveClose,reject)=>vite.httpServer.close(error=>error?reject(error):resolveClose())); await runtime.close(); store.close(); await rm(temp,{recursive:true,force:true});
}
