import { createApiClient } from './api-client.js';
const api = createApiClient(); const $ = id => document.getElementById(id);
let visibleArticle = null; let commentGeneration = 0; let auditGeneration = 0; let commentInputGeneration = 0;
let editorGeneration = 0;
let user = null; let selected = null; let publicRequest; let publicGeneration = 0; let ownGeneration = 0;
function message(text) { $('message').textContent = text; }
function errorText(error) { return `${error.message}${error.requestId ? `\n查詢代碼：${error.requestId}` : ''}`; }
function identity(value) { commentInputGeneration++; $('comment-content').value = ''; auditGeneration++; $('audit-result').textContent = ''; user = value; $('identity').textContent = user ? `已登入：${user.displayName}（${user.role}）` : '尚未登入'; $('workspace').hidden = !user; $('auth').hidden = !!user; $('logout').hidden = !user; $('admin-panel').hidden = user?.role !== 'admin'; $('comment-form').hidden = !user; if (!user) document.querySelectorAll('[data-comment-delete]').forEach(button => button.remove()); }
function clearEditor() { editorGeneration++; selected = null; $('editor').reset(); $('editor-state').textContent = '建立新草稿'; $('save').textContent = '建立草稿'; }
async function act(button, work) {
  button.disabled = true;
  try { await work(); } catch (error) { if (error.code === 'UNAUTHENTICATED') { ownGeneration++; identity(null); $('own-list').replaceChildren(); clearEditor(); api.setCsrf(undefined); try { const fresh = await api.request('/api/auth/csrf'); api.setCsrf(fresh.data.csrfToken); } catch {} } message(errorText(error)); }
  finally { button.disabled = false; }
}
async function bootstrap() {
  const csrf = await api.request('/api/auth/csrf'); api.setCsrf(csrf.data.csrfToken);
  try { identity((await api.request('/api/auth/me')).data); } catch (error) { if (error.code !== 'UNAUTHENTICATED') throw error; identity(null); }
  if (user) await loadOwn();
}
async function loadPublic() {
  publicRequest?.abort(); const controller = new AbortController(); publicRequest = controller; const generation = ++publicGeneration;
  $('public-state').textContent = '載入中…';
  try {
    const q = $('search').value.trim(); const result = await api.request('/api/articles' + (q ? `?q=${encodeURIComponent(q)}` : ''), { signal: controller.signal });
    if (generation !== publicGeneration) return;
    $('public-list').replaceChildren(...result.data.map(article => articleRow(article, false)));
    $('public-state').textContent = result.data.length ? `共 ${result.meta.total} 篇；此頁 ${result.data.length} 篇` : '沒有符合的公開文章。';
  } catch (error) { if (generation === publicGeneration && error.code !== 'CANCELLED') { $('public-state').textContent = '載入失敗，請重試。'; message(errorText(error)); } }
}
async function loadOwn() {
  const generation = ++ownGeneration; const result = await api.request('/api/me/articles');
  if (!user || generation !== ownGeneration) return;
  $('own-list').replaceChildren(...result.data.map(article => articleRow(article, true)));
}
function articleRow(article, own) {
  const row = document.createElement('li'); row.dataset.id = article.id;
  const heading = document.createElement('strong'); heading.textContent = article.title;
  const text = document.createElement('p'); text.textContent = article.content;
  const state = document.createElement('p'); state.textContent = `${article.status} · version ${article.version}`;
  row.append(heading, text, state);
  if (!own) { const read = document.createElement('button'); read.textContent = '閱讀留言'; read.dataset.action = 'comments'; read.onclick = () => act(read, () => loadComments(article)); row.append(read); }
  if (own && article.status !== 'archived') {
    const edit = document.createElement('button'); edit.textContent = '編輯'; edit.dataset.action = 'edit';
    edit.onclick = () => { editorGeneration++; selected = { ...article }; $('title').value = article.title; $('content').value = article.content; $('editor-state').textContent = `編輯 version ${article.version}`; $('save').textContent = '儲存修改'; };
    row.append(edit);
    for (const action of article.status === 'draft' ? ['publish', 'archive'] : ['archive']) {
      const button = document.createElement('button'); button.textContent = action === 'publish' ? '發佈' : '封存'; button.dataset.action = action;
      button.onclick = () => act(button, async () => { const generation = editorGeneration; await api.request(`/api/articles/${encodeURIComponent(article.id)}/${action}`, { method: 'POST', body: { expectedVersion: article.version } }); if (generation === editorGeneration && selected?.id === article.id) clearEditor(); await loadOwn(); await loadPublic(); message(action === 'publish' ? '已發佈。' : '已封存。'); }); row.append(button);
    }
  }
  return row;
}
$('auth-form').onsubmit = event => { event.preventDefault(); act($('login'), async () => {
  const password = $('password').value; $('password').value = '';
  const result = await api.request('/api/auth/login', { method: 'POST', body: { email: $('email').value, password } }); api.setCsrf(result.data.csrfToken); identity(result.data.user); await loadOwn(); message('登入成功。');
}); };
$('register').onclick = () => act($('register'), async () => { const password = $('password').value; $('password').value = ''; await api.request('/api/auth/register', { method: 'POST', body: { email: $('email').value, password, displayName: $('display-name').value } }); message('註冊成功，請登入。'); });
$('logout').onclick = () => act($('logout'), async () => { await api.request('/api/auth/logout', { method: 'POST', body: {} }); ownGeneration++; api.setCsrf(undefined); identity(null); $('own-list').replaceChildren(); clearEditor(); await bootstrap(); message('已登出。'); });
$('editor').onsubmit = event => { event.preventDefault(); act($('save'), async () => { const editing = selected; const generation = editorGeneration; const body = { title: $('title').value, content: $('content').value, ...(editing ? { expectedVersion: editing.version } : {}) }; await api.request(editing ? `/api/articles/${encodeURIComponent(editing.id)}` : '/api/articles', { method: editing ? 'PATCH' : 'POST', body }); const unchanged = generation === editorGeneration; if (unchanged) clearEditor(); await loadOwn(); const completed = editing ? '已儲存修改。' : '已建立草稿。'; message(unchanged ? completed : `${completed} 目前的輸入尚未送出，已保留。`); }); };
$('editor').addEventListener('input', () => { editorGeneration++; });
$('new').onclick = clearEditor;
$('refresh-own').onclick = () => act($('refresh-own'), async () => { await loadOwn(); message('本人列表已重新載入；選擇編輯以取得新版本。'); });
$('search-form').onsubmit = event => { event.preventDefault(); void loadPublic(); };
$('refresh-public').onclick = () => void loadPublic();
void bootstrap().then(loadPublic).catch(error => message(errorText(error)));

async function loadComments(article) {
  const generation = ++commentGeneration;
  if (visibleArticle?.id !== article.id) {
    visibleArticle = article; commentInputGeneration++; $('comment-content').value = '';
    $('comments-title').textContent = `${article.title} 的留言`; $('comments-list').replaceChildren();
    $('comments-panel').hidden = false; $('comment-form').hidden = true;
  }
  try {
    const result = await api.request(`/api/articles/${encodeURIComponent(article.id)}/comments`);
    if (generation !== commentGeneration) return;
    $('comment-form').hidden = !user;
    $('comments-list').replaceChildren(...result.data.map(comment => {
      const row = document.createElement('li'); row.dataset.commentId = comment.id;
      const text = document.createElement('p'); text.textContent = comment.content; row.append(text);
      if (user && (user.id === comment.authorId || user.role === 'admin')) {
        const button = document.createElement('button'); button.textContent = '刪除留言'; button.dataset.commentDelete = comment.id;
        button.onclick = () => act(button, async () => {
          await api.request(`/api/comments/${encodeURIComponent(comment.id)}`, { method: 'DELETE' });
          await refreshCommentsAfterWrite(article, '已刪除留言。');
        }); row.append(button);
      }
      return row;
    }));
  } catch (error) {
    if (generation === commentGeneration) { visibleArticle = null; $('comments-panel').hidden = true; $('comments-list').replaceChildren(); }
    throw error;
  }
}
async function refreshCommentsAfterWrite(article, success) {
  if (visibleArticle?.id !== article.id) { message(success); return; }
  try { await loadComments(article); message(success); }
  catch { message(`${success} 留言列表無法更新，請重新載入。`); }
}
$('comment-content').addEventListener('input', () => { commentInputGeneration++; });
$('comment-form').onsubmit = event => { event.preventDefault(); if (!visibleArticle) return; act($('comment-save'), async () => {
  const article = visibleArticle; const generation = commentInputGeneration;
  await api.request(`/api/articles/${encodeURIComponent(article.id)}/comments`, { method: 'POST', body: { content: $('comment-content').value } });
  if (visibleArticle?.id === article.id && generation === commentInputGeneration) $('comment-content').value = '';
  await refreshCommentsAfterWrite(article, '已新增留言。');
}); };
$('audit-form').onsubmit = event => { event.preventDefault(); act($('audit-load'), async () => {
  const generation = ++auditGeneration; const actorId = user?.id;
  const result = await api.request(`/api/admin/articles/${encodeURIComponent($('audit-article').value)}/status-audits`);
  if (generation !== auditGeneration || user?.id !== actorId || user?.role !== 'admin') return;
  $('audit-result').textContent = JSON.stringify(result, null, 2); message('已載入狀態稽核。');
}); };
