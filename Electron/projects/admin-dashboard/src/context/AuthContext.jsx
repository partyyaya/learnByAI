import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, setAuthToken, setUnauthorizedHandler } from "../api/client";
import { useToast } from "./ToastContext";

const LAST_ACCOUNT_KEY = "admin.lastAccount";

// 權限表。真後端也會擋（server.js 的 route.roles），前端這份只是為了「不要給
// 使用者看到按了一定失敗的按鈕」。兩邊都要有——只擋前端等於沒擋。
//
// 匯出是為了「角色與權限」那一頁可以直接把整張表畫出來。若是各頁自己抄一份，
// 改了權限之後那一頁就會開始說謊。
export const PERMISSIONS = {
  admin: ["users.write", "users.delete", "system.write"],
  editor: ["users.write", "system.write"],
  viewer: []
};

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const toast = useToast();
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  // 被踢出來的原因，登入頁會拿它顯示提示（「登入已逾期，請重新登入」）
  const [signOutReason, setSignOutReason] = useState("");

  const clearSession = useCallback((reason = "") => {
    setAuthToken("");
    setUser(null);
    setSession(null);
    setSignOutReason(reason);
  }, []);

  // 任何一支 API 回 401 都會走到這裡：清掉狀態＝畫面自動退回登入頁
  // （見 App.jsx 的 RequireAuth，它是看 user 有沒有值）
  useEffect(() => {
    setUnauthorizedHandler((error) => {
      clearSession(error.message);
      toast.error(error.message);
    });
    return () => setUnauthorizedHandler(null);
  }, [clearSession, toast]);

  const login = useCallback(async ({ account, password }) => {
    const data = await api.post("/auth/login", { account, password });

    setAuthToken(data.token);
    setUser(data.user);
    setSession({ expiresInMinutes: data.expiresInMinutes });
    setSignOutReason("");

    // 只記帳號，不記密碼。下次開 App 帳號欄自動填好，密碼還是要重打
    try {
      localStorage.setItem(LAST_ACCOUNT_KEY, account);
    } catch {
      // 存不起來就算了，不影響登入
    }

    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      // 告訴伺服器把 token 作廢。失敗也照樣登出——不能因為伺服器沒回應就把
      // 使用者留在後台裡面
      await api.post("/auth/logout");
    } catch {
      // 忽略：本地端的登出一定要成功
    }
    clearSession();
    toast.info("已登出");
  }, [clearSession, toast]);

  const can = useCallback(
    (permission) => (PERMISSIONS[user?.role] ?? []).includes(permission),
    [user]
  );

  const value = useMemo(
    () => ({
      user,
      session,
      signOutReason,
      isAuthenticated: Boolean(user),
      lastAccount: (() => {
        try {
          return localStorage.getItem(LAST_ACCOUNT_KEY) ?? "";
        } catch {
          return "";
        }
      })(),
      login,
      logout,
      can
    }),
    [user, session, signOutReason, login, logout, can]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth 必須放在 <AuthProvider> 裡面");
  return context;
}
