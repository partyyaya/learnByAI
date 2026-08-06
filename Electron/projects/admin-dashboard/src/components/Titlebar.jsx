/**
 * 自己畫的標題列。
 *
 * 系統標題列的底色是作業系統決定的，App 改不動，所以深色後台的最上面會突然頂一條
 * 淺色。main.js 把原生標題列藏起來（titleBarStyle: hidden / hiddenInset）之後，
 * 那一條就由這個元件補上，顏色跟側邊欄、導航欄同一個 var(--surface)。
 *
 * 代價是視窗變得不能拖：原生標題列不見了，就沒有可以按住移動視窗的地方。所以
 * .titlebar 一定要有 -webkit-app-region: drag（見 global.css）。
 *
 * 這裡刻意不放按鈕。標題列上的東西預設是「拖曳區」而不是「可以點的東西」，
 * 每加一個互動元件就要記得替它關掉拖曳，能不放就不放。
 */
export function Titlebar() {
  return (
    <div className="titlebar">
      <span className="titlebar__title">後台管理</span>
    </div>
  );
}
