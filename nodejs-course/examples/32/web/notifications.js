import {createApiClient} from './api-client.js';
const api=createApiClient();
const $=id=>document.getElementById(id);
let eventSource,socket,identity,cursor='0',generation=0;
const state=text=>{$('connection-state').textContent=text;};
const buttons=disabled=>{for(const id of ['start-sse','start-ws','catch-up'])$(id).disabled=disabled;};
function append(row){
  if(!/^[1-9][0-9]{0,18}$/.test(row.seq)||typeof row.articleId!=='string'||!Number.isSafeInteger(row.articleVersion))throw new Error('invalid notification');
  if(BigInt(row.seq)<=BigInt(cursor))return;
  cursor=row.seq;
  const item=document.createElement('li');item.dataset.seq=row.seq;item.textContent=`${row.articleId} 已發佈 version ${row.articleVersion}`;
  $('notification-list').append(item);
  while($('notification-list').children.length>50)$('notification-list').firstChild.remove();
}
function stop(){generation++;eventSource?.close();eventSource=undefined;socket?.close();socket=undefined;if(identity)$('catch-up').disabled=false;state('已停止；可從目前游標重新連線。');}
function lock(){stop();identity=undefined;cursor='0';$('notification-list').replaceChildren();buttons(true);state('Session 已失效或身分已改變，請回工作台登入後重新載入。');}
async function verifyIdentity(current=generation){
  try{
    const result=await api.request('/api/auth/me');
    if(current!==generation)return false;
    if(!identity||result.data.id!==identity){lock();return false;}
    return true;
  }catch(error){if(current===generation&&error.status===401)lock();return false;}
}
$('start-sse').onclick=()=>{
  stop();const current=generation;eventSource=new EventSource('/api/me/events?after='+cursor);
  eventSource.onopen=()=>{if(current===generation)state('SSE 已連線');};
  eventSource.addEventListener('article-published',event=>{if(current!==generation)return;try{append(JSON.parse(event.data));}catch{stop();state('通知格式錯誤，請重新載入。');}});
  eventSource.onerror=()=>{if(current===generation){state('SSE 連線中斷；將以原游標重連，Session 失效時請重新登入。');void verifyIdentity(current);}};
};
$('start-ws').onclick=()=>{
  stop();const current=generation;socket=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/api/me/socket');
  socket.onopen=()=>{if(current!==generation)return;socket.send(JSON.stringify({after:cursor}));state('WebSocket 已連線');};
  socket.onmessage=event=>{if(current!==generation)return;try{append(JSON.parse(event.data));}catch{stop();state('通知格式錯誤，請重新載入。');}};
  socket.onclose=()=>{if(current===generation){state('WebSocket 已關閉，請補抓或重新登入再連線。');void verifyIdentity(current);}};
  socket.onerror=()=>{if(current===generation)state('WebSocket 無法連線。');};
};
$('catch-up').onclick=async()=>{
  const current=generation;$('catch-up').disabled=true;
  try{
    if(!await verifyIdentity(current))return;
    let more=false;
    for(let page=0;page<5;page++){
      const result=await api.request('/api/me/notifications?after='+cursor);if(current!==generation)return;
      for(const row of result.data)append(row);
      more=result.data.length===result.meta.limit;if(!more)break;
    }
    state(more?'本次最多補抓100筆，請再次按補抓。':'補抓完成。');
  }catch(error){if(current===generation){if(error.status===401)lock();else state('無法補抓，請確認登入與連線。');}}
  finally{if(current===generation&&identity)$('catch-up').disabled=false;}
};
$('stop-stream').onclick=stop;
window.addEventListener('pagehide',stop);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&identity)void verifyIdentity();});
api.request('/api/auth/me').then(result=>{identity=result.data.id;buttons(false);state('已登入，可選擇連線方式。');}).catch(()=>lock());
