import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useApi } from "../hooks/useApi";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { DataTable } from "../components/DataTable";
import { Pagination } from "../components/Pagination";
import { Select } from "../components/Select";
import { StatusBadge } from "../components/StatusBadge";
import { IconRefresh, IconSearch } from "../components/icons";
import { ORDER_STATUS, formatCurrency, formatDateTime, formatNumber } from "../utils/format";

const CHANNELS = ["官網", "行動 App", "門市 POS", "電話訂購", "經銷商"];

export function OrdersPage() {
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState("");
  const [channel, setChannel] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const debouncedKeyword = useDebouncedValue(keyword, 350);

  const { data, loading, error, reload } = useApi(
    () => api.get("/orders", { page, pageSize, keyword: debouncedKeyword, status, channel }),
    [page, pageSize, debouncedKeyword, status, channel]
  );

  useEffect(() => {
    setPage(1);
  }, [debouncedKeyword, status, channel, pageSize]);

  const columns = [
    {
      key: "id",
      header: "訂單編號",
      width: "140px",
      render: (row) => <code className="code">{row.id}</code>
    },
    { key: "customerName", header: "客戶", width: "100px" },
    { key: "product", header: "商品" },
    { key: "channel", header: "通路", width: "100px" },
    { key: "quantity", header: "數量", width: "70px", align: "right" },
    {
      key: "amount",
      header: "金額",
      width: "120px",
      align: "right",
      // 金額欄用 tabular-nums（CSS 的 .num），數字才會上下對齊
      render: (row) => <span className="num">{formatCurrency(row.amount)}</span>
    },
    {
      key: "status",
      header: "狀態",
      width: "90px",
      render: (row) => <StatusBadge dictionary={ORDER_STATUS} value={row.status} />
    },
    {
      key: "createdAt",
      header: "成立時間",
      width: "150px",
      render: (row) => formatDateTime(row.createdAt)
    }
  ];

  return (
    <div className="page">
      <div className="toolbar">
        <label className="field field--search">
          <span className="field__control">
            <IconSearch size={16} />
            <input
              type="search"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜尋訂單編號、客戶、商品"
            />
          </span>
        </label>

        <Select
          value={status}
          onChange={setStatus}
          placeholder="全部狀態"
          options={Object.entries(ORDER_STATUS).map(([value, meta]) => ({ value, label: meta.label }))}
          aria-label="狀態篩選"
        />

        <Select
          value={channel}
          onChange={setChannel}
          placeholder="全部通路"
          options={CHANNELS.map((item) => ({ value: item, label: item }))}
          aria-label="通路篩選"
        />

        <button type="button" className="btn btn--ghost btn--compact" onClick={reload} disabled={loading}>
          <IconRefresh size={16} />
          重新載入
        </button>
      </div>

      {/* 篩選條件下的小結。金額不含退款與取消的訂單，跟後端算的是同一套規則 */}
      {data?.summary ? (
        <div className="summary-strip">
          <span>
            符合條件 <strong>{formatNumber(data.summary.count)}</strong> 筆
          </span>
          <span>
            有效營收 <strong className="num">{formatCurrency(data.summary.revenue)}</strong>
            <small>（不含已退款、已取消）</small>
          </span>
        </div>
      ) : null}

      <DataTable
        columns={columns}
        rows={data?.items}
        rowKey={(row) => row.id}
        loading={loading}
        error={error}
        onRetry={reload}
        emptyTitle="沒有符合條件的訂單"
        emptyText="試著清掉關鍵字或篩選條件"
      />

      <Pagination
        pagination={data?.pagination}
        onChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={setPageSize}
      />
    </div>
  );
}
