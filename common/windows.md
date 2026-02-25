# Windows 常用指令手冊（CMD + PowerShell）

這份文件整理 Windows 開發與維運最常用的命令列指令，涵蓋：

- CMD（命令提示字元）
- PowerShell
- 網路、程序、服務、檔案操作常見情境

---

## 1. 先認識兩種命令列

- **CMD**：傳統 Windows 命令列，語法較簡單，舊腳本相容性高
- **PowerShell**：功能更完整，支援物件管線，適合自動化與系統管理

常見做法：

- 舊專案批次檔（`.bat`）多用 CMD
- 新的維運與自動化腳本多用 PowerShell

---

## 2. 目錄與檔案操作

| 目的 | CMD | PowerShell |
|------|-----|------------|
| 顯示目前路徑 | `cd` | `Get-Location` |
| 列出檔案 | `dir` | `Get-ChildItem`（`ls`） |
| 切換資料夾 | `cd path` | `Set-Location path`（`cd`） |
| 建立資料夾 | `mkdir demo` | `New-Item -ItemType Directory demo` |
| 建立空檔 | `type nul > a.txt` | `New-Item -ItemType File a.txt` |
| 複製 | `copy a.txt b.txt` | `Copy-Item a.txt b.txt` |
| 移動 | `move a.txt .\backup\` | `Move-Item a.txt .\backup\` |
| 重新命名 | `ren old.txt new.txt` | `Rename-Item old.txt new.txt` |
| 刪除檔案 | `del a.txt` | `Remove-Item a.txt` |
| 刪除資料夾 | `rmdir /s /q demo` | `Remove-Item demo -Recurse -Force` |

```powershell
# PowerShell：列出目前資料夾下所有檔案（含子目錄）
Get-ChildItem -Recurse

# PowerShell：複製整個資料夾
Copy-Item .\src .\src-backup -Recurse
```

---

## 3. 查看檔案內容與搜尋

| 目的 | CMD | PowerShell |
|------|-----|------------|
| 顯示檔案內容 | `type app.log` | `Get-Content app.log` |
| 看最後幾行 | 無內建 tail（可配合 `more`） | `Get-Content app.log -Tail 50` |
| 即時追蹤日誌 | 無內建 | `Get-Content app.log -Wait` |
| 關鍵字搜尋 | `findstr /s /n /i "error" *.log` | `Select-String -Path .\*.log -Pattern "error"` |

```cmd
:: CMD：遞迴搜尋目前目錄所有 .log 的 error 字串
findstr /s /n /i "error" *.log
```

---

## 4. 程序與服務管理

### 4.1 程序（Process）

| 目的 | CMD | PowerShell |
|------|-----|------------|
| 查看程序 | `tasklist` | `Get-Process` |
| 結束程序 | `taskkill /PID 1234 /F` | `Stop-Process -Id 1234 -Force` |

### 4.2 服務（Service）

| 目的 | CMD | PowerShell |
|------|-----|------------|
| 查看服務 | `sc query` | `Get-Service` |
| 啟動服務 | `net start <service>` | `Start-Service <service>` |
| 停止服務 | `net stop <service>` | `Stop-Service <service>` |
| 重啟服務 | （先 stop 再 start） | `Restart-Service <service>` |

---

## 5. 網路診斷

| 目的 | 指令 |
|------|------|
| 查看網卡/IPv4/IPv6 | `ipconfig /all` |
| 測試連線 | `ping example.com` |
| 路由追蹤 | `tracert example.com` |
| DNS 查詢 | `nslookup example.com` |
| 查看連線與監聽埠 | `netstat -ano` |
| 測試 TCP 連線（PowerShell） | `Test-NetConnection host -Port 443` |

常見排錯：

```cmd
:: 找誰佔用 8080 port
netstat -ano | findstr :8080

:: 假設 PID 是 1234，查對應程序
tasklist | findstr 1234
```

---

## 6. 系統資訊與環境變數

| 目的 | CMD | PowerShell |
|------|-----|------------|
| 系統資訊 | `systeminfo` | `Get-ComputerInfo` |
| 目前使用者 | `whoami` | `whoami` |
| 查看環境變數 | `set` | `Get-ChildItem Env:` |
| 讀取 PATH | `echo %PATH%` | `$env:PATH` |
| 永久設定環境變數 | `setx APP_ENV production` | `[Environment]::SetEnvironmentVariable("APP_ENV","production","User")` |

---

## 7. 檔案壓縮與解壓

```powershell
# 建立 zip
Compress-Archive -Path .\dist\* -DestinationPath .\dist.zip

# 解壓 zip
Expand-Archive -Path .\dist.zip -DestinationPath .\dist-unzip
```

Windows 10/11 也可直接用 `tar`：

```cmd
tar -xf archive.tar
tar -czf backup.tar.gz .\project
```

---

## 8. 套件管理（winget）

```powershell
# 搜尋套件
winget search vscode

# 安裝套件
winget install Microsoft.VisualStudioCode

# 升級全部可升級套件
winget upgrade --all
```

---

## 9. 一頁速查（最常用）

```powershell
# 路徑與檔案
Get-Location
Get-ChildItem -Force
Set-Location C:\work

# 文字搜尋
Select-String -Path .\*.log -Pattern "error"
Get-Content .\app.log -Tail 100 -Wait

# 程序與服務
Get-Process
Stop-Process -Id 1234 -Force
Get-Service
Restart-Service Spooler

# 網路
ipconfig /all
netstat -ano
Test-NetConnection example.com -Port 443
```

---

## 10. 常見注意事項

- 刪除指令（`del`、`rmdir /s /q`、`Remove-Item -Recurse -Force`）都要先確認路徑
- PowerShell 與 CMD 的語法不同，腳本不要混用
- 需要管理員權限時，請以「系統管理員身分」開啟終端機
- 服務名稱通常不是顯示名稱，先用 `Get-Service` 或 `sc query` 確認

