document.getElementById('cors-run').onclick = async () => {
  try { const response = await fetch('http://127.0.0.1:4031/lab/state', { credentials: 'include', headers: { 'X-Lab-Token': 'teaching-only' } });
    const value = await response.json(); document.getElementById('cors-result').textContent = response.ok && value.data.ok ? '跨來源讀取成功' : '讀取被拒絕';
  } catch { document.getElementById('cors-result').textContent = '瀏覽器拒絕讀取（檢查 Origin／preflight）'; }
};
