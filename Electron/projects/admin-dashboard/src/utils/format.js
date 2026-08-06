// 顯示用的格式化與字典。全部集中在這裡，才不會同一個 status 在使用者頁翻成
// 「停用」、在儀表板翻成「已停用」。

const dateTimeFormatter = new Intl.DateTimeFormat("zh-TW", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

const dateFormatter = new Intl.DateTimeFormat("zh-TW", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

const numberFormatter = new Intl.NumberFormat("zh-TW");

export function formatDateTime(iso) {
  if (!iso) return "—";
  return dateTimeFormatter.format(new Date(iso));
}

export function formatDate(iso) {
  if (!iso) return "—";
  return dateFormatter.format(new Date(iso));
}

/** 「3 分鐘前」。列表裡看相對時間比看絕對時間直覺 */
export function formatRelative(iso) {
  if (!iso) return "—";

  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);

  if (minutes < 1) return "剛剛";
  if (minutes < 60) return `${minutes} 分鐘前`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;

  return formatDate(iso);
}

export function formatNumber(value) {
  return numberFormatter.format(value ?? 0);
}

export function formatCurrency(value) {
  return `NT$ ${numberFormatter.format(value ?? 0)}`;
}

/** 大數字在 KPI 卡上要縮寫，不然 3,240,000 會把卡片撐爆 */
export function formatCompact(value) {
  const number = value ?? 0;
  if (Math.abs(number) >= 10000) return `${(number / 10000).toFixed(1)} 萬`;
  return numberFormatter.format(number);
}

// ---------------------------------------------------------------------------
// 字典
// ---------------------------------------------------------------------------

export const USER_STATUS = {
  active: { label: "啟用", tone: "success" },
  disabled: { label: "停用", tone: "neutral" },
  pending: { label: "待驗證", tone: "warning" }
};

export const USER_ROLE = {
  admin: { label: "系統管理員", tone: "brand" },
  editor: { label: "編輯者", tone: "info" },
  viewer: { label: "唯讀", tone: "neutral" }
};

/** 權限代號 → 人話。代號本身在 AuthContext 的 PERMISSIONS 表裡 */
export const PERMISSION_LABELS = {
  "users.write": "修改使用者（角色、啟用狀態）",
  "users.delete": "刪除使用者",
  "system.write": "修改模擬後端參數"
};

export const ORDER_STATUS = {
  paid: { label: "已付款", tone: "success" },
  processing: { label: "處理中", tone: "info" },
  shipped: { label: "已出貨", tone: "brand" },
  pending: { label: "待付款", tone: "warning" },
  refunded: { label: "已退款", tone: "danger" },
  cancelled: { label: "已取消", tone: "neutral" }
};

/** 字典裡沒有的值也要能顯示，不要變成空白 */
export function describe(dictionary, key) {
  return dictionary[key] ?? { label: key ?? "—", tone: "neutral" };
}
