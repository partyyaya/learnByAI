import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useApi, useMutation } from "../hooks/useApi";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { useConfirm } from "../components/ConfirmDialog";
import { DataTable } from "../components/DataTable";
import { Pagination } from "../components/Pagination";
import { Select } from "../components/Select";
import { StatusBadge } from "../components/StatusBadge";
import { IconRefresh, IconSearch, IconTrash } from "../components/icons";
import { USER_ROLE, USER_STATUS, formatDate, formatRelative } from "../utils/format";

export function UsersPage() {
  const { user: me, can } = useAuth();
  const toast = useToast();
  const { confirm, confirmElement } = useConfirm();

  const [keyword, setKeyword] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // 打字時不要每個字都送一次請求，停手 350ms 才送
  const debouncedKeyword = useDebouncedValue(keyword, 350);

  const { data, loading, error, reload } = useApi(
    () => api.get("/users", { page, pageSize, keyword: debouncedKeyword, role, status }),
    [page, pageSize, debouncedKeyword, role, status]
  );

  // 換篩選條件要回到第一頁。停在第 5 頁然後搜尋一個只有 3 筆結果的關鍵字，
  // 畫面會是空的——使用者只會覺得「搜不到」，不會想到是分頁的問題。
  useEffect(() => {
    setPage(1);
  }, [debouncedKeyword, role, status, pageSize]);

  // 刪到某一頁一筆都不剩時，伺服器會把頁碼往回夾（見 server.js 的 paginate），
  // 這裡把本地狀態同步過去，否則下次請求又會送出那個不存在的頁碼。
  const serverPage = data?.pagination?.page;
  useEffect(() => {
    if (serverPage && serverPage !== page) setPage(serverPage);
  }, [serverPage, page]);

  const { run: mutate, pending } = useMutation(async (task) => {
    try {
      await task();
      reload();
    } catch (apiError) {
      // 403 之類的錯誤直接把伺服器的訊息顯示出來。權限判斷前後端都有，
      // 但真正說得準的是後端
      toast.error(apiError.message);
    }
  });

  const toggleStatus = (row) =>
    mutate(async () => {
      const next = row.status === "active" ? "disabled" : "active";
      await api.patch(`/users/${row.id}`, { status: next });
      toast.success(`已將 ${row.name} 設為${USER_STATUS[next].label}`);
    });

  const changeRole = (row, nextRole) =>
    mutate(async () => {
      await api.patch(`/users/${row.id}`, { role: nextRole });
      toast.success(`已將 ${row.name} 的角色改為${USER_ROLE[nextRole].label}`);
    });

  const removeUser = async (row) => {
    const confirmed = await confirm({
      title: "刪除使用者",
      message: `確定要刪除「${row.name}」（${row.account}）嗎？此操作無法復原。`,
      confirmText: "刪除",
      tone: "danger"
    });
    if (!confirmed) return;

    mutate(async () => {
      await api.del(`/users/${row.id}`);
      toast.success(`已刪除 ${row.name}`);
    });
  };

  const columns = [
    {
      key: "name",
      header: "使用者",
      render: (row) => (
        <div className="cell-user">
          <span className="avatar avatar--sm">{row.name.slice(0, 1)}</span>
          <span>
            <strong>
              {row.name}
              {row.id === me?.id ? <em className="cell-user__self">你</em> : null}
            </strong>
            <small>{row.email}</small>
          </span>
        </div>
      )
    },
    { key: "department", header: "部門", width: "110px" },
    {
      key: "role",
      header: "角色",
      width: "140px",
      render: (row) =>
        can("users.write") ? (
          <Select
            className="select--inline"
            value={row.role}
            disabled={pending}
            onChange={(nextRole) => changeRole(row, nextRole)}
            options={Object.entries(USER_ROLE).map(([value, meta]) => ({ value, label: meta.label }))}
            aria-label={`${row.name} 的角色`}
          />
        ) : (
          <StatusBadge dictionary={USER_ROLE} value={row.role} />
        )
    },
    {
      key: "status",
      header: "狀態",
      width: "90px",
      render: (row) => <StatusBadge dictionary={USER_STATUS} value={row.status} />
    },
    { key: "createdAt", header: "建立日期", width: "110px", render: (row) => formatDate(row.createdAt) },
    {
      key: "lastLoginAt",
      header: "最後登入",
      width: "110px",
      render: (row) => formatRelative(row.lastLoginAt)
    },
    {
      key: "actions",
      header: "操作",
      width: "150px",
      align: "right",
      render: (row) => (
        <div className="cell-actions">
          <button
            type="button"
            className="btn btn--ghost btn--compact"
            disabled={pending || !can("users.write")}
            title={can("users.write") ? undefined : "權限不足"}
            onClick={() => toggleStatus(row)}
          >
            {row.status === "active" ? "停用" : "啟用"}
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--danger"
            disabled={pending || !can("users.delete") || row.id === me?.id}
            title={
              row.id === me?.id
                ? "不能刪除自己的帳號"
                : can("users.delete")
                  ? "刪除"
                  : "權限不足"
            }
            onClick={() => removeUser(row)}
          >
            <IconTrash size={16} />
          </button>
        </div>
      )
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
              placeholder="搜尋姓名、帳號、Email、部門"
            />
          </span>
        </label>

        <Select
          value={role}
          onChange={setRole}
          placeholder="全部角色"
          options={Object.entries(USER_ROLE).map(([value, meta]) => ({ value, label: meta.label }))}
          aria-label="角色篩選"
        />

        <Select
          value={status}
          onChange={setStatus}
          placeholder="全部狀態"
          options={Object.entries(USER_STATUS).map(([value, meta]) => ({ value, label: meta.label }))}
          aria-label="狀態篩選"
        />

        <button type="button" className="btn btn--ghost btn--compact" onClick={reload} disabled={loading}>
          <IconRefresh size={16} />
          重新載入
        </button>
      </div>

      <DataTable
        columns={columns}
        rows={data?.items}
        rowKey={(row) => row.id}
        loading={loading}
        error={error}
        onRetry={reload}
        emptyTitle="沒有符合條件的使用者"
        emptyText="試著清掉關鍵字或篩選條件"
      />

      <Pagination
        pagination={data?.pagination}
        onChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={setPageSize}
      />

      {confirmElement}
    </div>
  );
}
