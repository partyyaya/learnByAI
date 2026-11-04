# Git 常用指令與實際情境指南

---

## 目錄

1. [基本設定](#1-基本設定)
2. [初始化與複製倉庫](#2-初始化與複製倉庫)
3. [日常工作流程](#3-日常工作流程)
4. [分支操作](#4-分支操作)
5. [推送與拉取遠端倉庫](#5-推送與拉取遠端倉庫)
6. [合併分支：Merge vs Rebase](#6-合併分支merge-vs-rebase)
7. [解決衝突](#7-解決衝突)
8. [暫存工作：Stash](#8-暫存工作stash)
9. [查看歷史紀錄](#9-查看歷史紀錄)
10. [撤銷與回復](#10-撤銷與回復)
11. [標籤管理](#11-標籤管理)
12. [Cherry Pick](#12-cherry-pick)
13. [常見情境與解決方案](#13-常見情境與解決方案)

---

## 1. 基本設定

```bash
# 設定使用者名稱與 Email（全域）
git config --global user.name "Your Name"
git config --global user.email "your@email.com"

# 查看目前設定
git config --list

# 設定預設編輯器
git config --global core.editor "code --wait"

# 設定預設分支名稱為 main
git config --global init.defaultBranch main

# 設定換行符號處理（Windows 建議）
git config --global core.autocrlf true
# macOS / Linux 建議
git config --global core.autocrlf input

# git pull 遇到本地與遠端分岔時，用 merge 整合（其他選項見第 5 節）
git config --global pull.rebase false
```

---

## 2. 初始化與複製倉庫

```bash
# 在目前目錄建立新的 Git 倉庫
git init

# 從遠端複製倉庫到本地
git clone https://github.com/user/repo.git

# 複製並指定資料夾名稱
git clone https://github.com/user/repo.git my-project

# 只複製最新一次 commit（節省空間與時間）
git clone --depth 1 https://github.com/user/repo.git

# 之後需要完整歷史時再補抓
git fetch --unshallow
```

---

## 3. 日常工作流程

### 查看狀態

```bash
# 查看目前工作區狀態（哪些檔案被修改、暫存等）
git status

# 精簡模式
git status -s
```

### 加入暫存區（Staging）

```bash
# 加入單一檔案
git add index.html

# 加入目前目錄（含子目錄）的所有變更
git add .

# 加入整個倉庫的所有變更（含刪除），不受目前所在目錄影響
git add -A

# 加入特定類型檔案（含子目錄）
git add '*.js'
# 要加引號：不加的話 shell 會先展開 *.js，只抓到目前目錄的檔案；
# zsh 找不到符合的檔案時還會直接報錯 no matches found

# 互動式加入（可選擇部分修改）
git add -p
```

### 提交（Commit）

```bash
# 提交並附帶訊息
git commit -m "feat: 新增登入功能"

# 加入暫存 + 提交（僅限已追蹤檔案）
git commit -am "fix: 修正首頁排版問題"

# 修改上一次的 commit 訊息
git commit --amend -m "fix: 修正首頁排版與字體問題"

# 將遺漏的檔案補進上一次 commit
git add forgot-file.js
git commit --amend --no-edit
```

`--amend` 不是修改原本的 commit，而是產生一個新的 commit 取代它（hash 會改變）。還沒 push 的 commit 可以放心 amend；已經 push 的 commit 被 amend 後，一般的 `git push` 會被拒絕，必須強制推送，所以多人共用的分支不要這樣做（原因見第 6 節的黃金法則）。

### 忽略檔案：.gitignore

在專案根目錄建立 `.gitignore`，列出不要納入版本控制的檔案：

```gitignore
# 忽略資料夾
node_modules/
dist/

# 忽略特定副檔名
*.log

# 忽略環境變數檔，但保留範本
.env
.env.*
!.env.example

# 開頭加 / 只忽略根目錄的 config.json，子目錄的不受影響
/config.json
```

```bash
# 查詢某個檔案被哪一條規則忽略
git check-ignore -v .env.local
# 輸出：.gitignore:10:.env.*	.env.local（第 10 行的 .env.* 規則忽略了它）

# 設定全域忽略清單（例如 macOS 的 .DS_Store），所有倉庫都適用
git config --global core.excludesFile ~/.gitignore_global
echo ".DS_Store" >> ~/.gitignore_global
```

`.gitignore` 只對還沒被追蹤的檔案有效。已經 commit 過的檔案，加進 `.gitignore` 也不會停止追蹤，處理方式見第 13 節情境 5。

---

## 4. 分支操作

### 建立與切換分支

```bash
# 查看所有本地分支
git branch

# 查看所有分支（含遠端）
git branch -a

# 建立新分支
git branch feature/login

# 切換到分支
git checkout feature/login

# 建立並切換到新分支（一步完成）
git checkout -b feature/login

# Git 2.23+ 推薦用法
git switch feature/login           # 切換
git switch -c feature/login        # 建立並切換
```

### 情境：從 main 開一個新功能分支開發

```bash
# 確保在 main 上，並拉取最新程式碼
git checkout main
git pull origin main

# 建立功能分支並切換過去
git checkout -b feature/user-profile

# 開發完成後，推送到遠端
git push -u origin feature/user-profile
# -u 會建立追蹤關係，之後只要 git push 即可
```

### 刪除分支

```bash
# 刪除本地分支（已合併）
git branch -d feature/login

# 強制刪除本地分支（未合併也刪除）
git branch -D feature/login

# 刪除遠端分支
git push origin --delete feature/login

# 清理已在遠端刪除的 origin/* 追蹤分支（本地分支不會被刪除，要自己用 git branch -d）
git fetch --prune
```

### 重新命名分支

```bash
# 重新命名目前所在分支
git branch -m new-branch-name

# 重新命名指定分支
git branch -m old-name new-name

# 如果已推上遠端，需要刪除舊的再推送新的
git push origin --delete old-name
git push -u origin new-name
```

---

## 5. 推送與拉取遠端倉庫

### 遠端倉庫管理

```bash
# 查看遠端倉庫
git remote -v

# 新增遠端倉庫
git remote add origin https://github.com/user/repo.git

# 修改遠端倉庫 URL
git remote set-url origin https://github.com/user/new-repo.git

# 移除遠端倉庫
git remote remove origin
```

### 推送（Push）

```bash
# 推送到遠端（首次推送需設定上游分支）
git push -u origin main

# 之後直接推送
git push

# 強制推送（覆蓋遠端歷史，慎用！）
git push --force

# 較安全的強制推送（會檢查遠端是否有新 commit）
git push --force-with-lease
```

### 拉取（Pull / Fetch）

```bash
# 拉取遠端變更並自動合併
git pull origin main

# 拉取但用 rebase 方式整合（保持線性歷史）
git pull --rebase origin main

# 僅拉取遠端資訊，不自動合併（更安全）
git fetch origin
git merge origin/main    # 手動決定何時合併
```

### 本地與遠端分岔時的 git pull

你在本地 commit 了、別人也 push 了新的 commit，兩邊的歷史就分岔了。這時 `git pull` 要知道用哪種方式整合，如果沒有設定過，會直接停下來：

```
hint: You have divergent branches and need to specify how to reconcile them.
...
fatal: Need to specify how to reconcile divergent branches.
```

選一種設成預設值即可：

```bash
# 用 merge 整合：產生一個 merge commit（第 1 節的設定）
git config --global pull.rebase false

# 用 rebase 整合：把本地 commit 接到遠端最新 commit 之後，歷史保持線性
git config --global pull.rebase true

# 只允許 fast-forward：分岔時一律停下來，由你自己決定 merge 或 rebase
git config --global pull.ff only
```

單次也可以直接指定：`git pull --rebase`、`git pull --no-rebase`、`git pull --ff-only`。

### 連線驗證：HTTPS 與 SSH

GitHub 從 2021 年 8 月起不接受用帳號密碼推送。用 HTTPS 網址時，`git push` 要求輸入密碼的地方要貼 Personal Access Token（建議用 Fine-grained token，只授權需要的 repo），或改用下面任一種方式：

- 安裝 [GitHub CLI](https://cli.github.com/) 後執行 `gh auth login`，它會幫你設定好 Git 的憑證。
- Git for Windows 內建 Git Credential Manager，第一次 push 時會開瀏覽器讓你登入。
- 改用 SSH：產生金鑰並加到 GitHub（步驟見 [CI/CD 教學的 SSH Key 設定](./ci-cd.md#步驟三設定-ssh-key如果尚未設定)），remote 網址改成 `git@github.com:` 開頭。

```bash
# 已經用 HTTPS clone 的倉庫，改成 SSH
git remote set-url origin git@github.com:user/repo.git
```

### 情境：本地倉庫首次推上 GitHub

```bash
# 1. 在 GitHub 建立空的 repo（不要勾選 README）
# 2. 在本地執行：
git init
# 先建立 .gitignore（見第 3 節），避免把 node_modules、.env 一起提交
git add .
git commit -m "init: 初始化專案"
git remote add origin https://github.com/user/my-project.git
git branch -M main
git push -u origin main
```

---

## 6. 合併分支：Merge vs Rebase

### Git Merge

將兩個分支的歷史合併，**保留完整的分支歷史紀錄**，會產生一個 merge commit。

```bash
# 將 feature/login 合併進 main
git checkout main
git merge feature/login
```

合併後的歷史看起來像這樣（feature/login 從 F 分出去之後，main 又多了 H）：

```
          A---B---C  feature/login
         /         \
D---E---F---H-------M  main（M 為 merge commit）
```

如果 feature/login 分出去之後 main 沒有任何新 commit，Git 會直接 fast-forward：把 main 指標往前移到 C，不產生 merge commit。想在這種情況也保留分支結構，用 `git merge --no-ff feature/login`。

**適用時機：**
- 多人協作的公共分支
- 需要保留完整開發歷史
- GitHub PR 的「Create a merge commit」按鈕（三種合併按鈕的差異見 [GitHub 協作指南 2.6](./github-collaboration.md#26-github-的三種合併方式)）

### Git Rebase

將分支的 commit **重新接到**目標分支的最新點上，產生**線性歷史**，不會產生 merge commit。

```bash
# 在 feature 分支上，將 commit 重新接到 main 最新點
git checkout feature/login
git rebase main

# rebase 完成後，切回 main 合併（此時為 fast-forward）
git checkout main
git merge feature/login
```

Rebase 後的歷史看起來像這樣：

```
原本（feature/login 從 F 分出去之後，main 又多了 G、H）：
          A---B---C  feature/login
         /
D---E---F---G---H  main

rebase 後：
                  A'--B'--C'  feature/login
                 /
D---E---F---G---H  main

merge 後（fast-forward）：
D---E---F---G---H---A'--B'--C'  main（線性歷史）
```

A'、B'、C' 的修改內容和 A、B、C 相同，但接在不同的 parent 上，所以是新的 commit，hash 也不同。

**適用時機：**
- 個人開發的 feature 分支
- 想保持 commit 歷史乾淨、線性
- 尚未推送，或只有你自己在用的分支

### Merge vs Rebase 比較表

| 特性 | Merge | Rebase |
|------|-------|--------|
| 歷史紀錄 | 保留完整分支結構 | 線性、乾淨 |
| Merge Commit | 會產生 | 不會產生 |
| 適合場景 | 公共分支、多人協作 | 個人分支、整理 commit |
| 衝突處理 | 一次處理所有衝突 | 逐一 commit 處理衝突 |
| 安全性 | 不改寫歷史，較安全 | 改寫歷史，需注意 |
| 風險 | 低 | 已推送的分支 rebase 會造成問題 |

### 黃金法則

> **永遠不要 rebase 別人也在使用的分支（例如 main、develop）！**
>
> Rebase 會改寫 commit hash，如果別人已經基於這些 commit 開發，會造成歷史混亂。

只有你自己在用的分支（例如送 PR 的 feature 分支）可以 rebase。但如果它已經推上遠端，rebase 後本地和遠端的 commit 不同，一般的 `git push` 會被拒絕，要改用：

```bash
git fetch origin
git rebase origin/main
git push --force-with-lease
```

`--force-with-lease` 只在遠端分支沒有你不知道的新 commit 時才覆蓋，比 `--force` 安全。PR 頁面會自動更新；如果 reviewer 正在看，先說一聲。

### Interactive Rebase（整理 commit）

```bash
# 互動式 rebase 最近 3 個 commit
git rebase -i HEAD~3
```

編輯器裡的清單是**由舊到新**排列（最上面是最舊的 commit），和 `git log` 的順序相反。每一行前面的指令可以改成：
- `pick`：保留 commit
- `reword`：修改 commit 訊息
- `squash`：合併到前一個 commit（保留訊息）
- `fixup`：合併到前一個 commit（丟棄訊息）
- `drop`：刪除 commit
- `edit`：暫停讓你修改

**情境：把多個零碎 commit 整理成一個有意義的 commit**

```bash
git rebase -i HEAD~4

# 編輯器中：
pick a1b2c3d feat: 新增登入頁面
squash d4e5f6a 修正 typo
squash b7c8d9e 調整樣式
squash f0a1b2c 補上驗證邏輯

# 儲存後會讓你編輯合併後的 commit 訊息
```

---

## 7. 解決衝突

### 衝突發生時的處理流程

```bash
# 合併時遇到衝突
git merge feature/login
# 輸出：CONFLICT (content): Merge conflict in src/app.js

# 查看衝突檔案
git status
```

打開衝突檔案，會看到這樣的標記：

```
<<<<<<< HEAD
console.log("main 分支的程式碼");
=======
console.log("feature 分支的程式碼");
>>>>>>> feature/login
```

上半段（`HEAD`）是目前所在分支 main 的內容，下半段是要合併進來的 feature/login。刪除標記、留下正確的程式碼後：

```bash
git add src/app.js
git commit -m "merge: 解決 app.js 衝突，合併 feature/login"
```

### Rebase 時的衝突

```bash
git rebase main
# 輸出：CONFLICT (content): Merge conflict in src/app.js

# 解決衝突後加入暫存，然後繼續 rebase（不要執行 git commit）
git add src/app.js
git rebase --continue

# 如果這個 commit 的修改已經不需要了，可以跳過它
git rebase --skip
```

Rebase 是把你的 commit 一個一個重新套用到 main 上，所以衝突標記的方向和 merge 相反：上半段 `HEAD` 是 main 的內容，下半段才是你正在套用的 commit。

### 整個檔案採用其中一邊

```bash
git checkout --ours src/app.js     # merge 時是目前分支；rebase 時是 main
git checkout --theirs src/app.js   # merge 時是被合併的分支；rebase 時是你的 commit
git add src/app.js
```

### 取消合併

```bash
# 合併衝突時想放棄，回到合併前的狀態
git merge --abort

# rebase 衝突時想放棄
git rebase --abort
```

### 使用工具解決衝突

```bash
# 使用設定好的合併工具
git mergetool

# 在 VS Code 中，衝突檔案會有圖形化介面可以選擇
```

---

## 8. 暫存工作：Stash

**情境：正在開發功能，突然需要切到別的分支修 bug**

```bash
# 暫存目前的工作（工作區會回到乾淨狀態）
git stash

# 暫存並附帶說明
git stash push -m "開發到一半的登入功能"

# 也暫存未追蹤的新檔案
git stash -u

# 查看暫存列表
git stash list
# 輸出：
# stash@{0}: On feature/login: 開發到一半的登入功能
# stash@{1}: WIP on main: abc1234 fix header

# 恢復最近一次暫存（並從 stash 列表移除）
git stash pop

# 恢復但不從列表移除
git stash apply

# 恢復特定的 stash
git stash apply stash@{1}
# 也可以只寫編號：git stash apply 1
# PowerShell 會把 @{ } 當成語法，要寫成 git stash apply 'stash@{1}' 或只寫編號

# 刪除特定 stash
git stash drop stash@{0}

# 清除所有 stash
git stash clear
```

---

## 9. 查看歷史紀錄

```bash
# 查看 commit 歷史
git log

# 精簡模式（一行一個 commit）
git log --oneline

# 顯示分支圖形
git log --oneline --graph --all

# 查看特定檔案的修改歷史
git log -- src/app.js

# 查看特定作者的 commit
git log --author="Gary"

# 查看最近 5 筆 commit
git log -5

# 搜尋 commit 訊息
git log --grep="login"

# 查看某段時間內的 commit
git log --after="2025-01-01" --before="2025-02-01"

# 查看 feature/login 有、main 沒有的 commit
git log main..feature/login

# 查看每個 commit 改了哪些內容
git log -p -- src/app.js

# 找出新增或刪除某段字串的 commit（例如某個函式是什麼時候被刪掉的）
git log -S "validateToken"
```

### 查看單一 commit 與逐行追蹤

```bash
# 查看某個 commit 的訊息與修改內容
git show abc1234

# 查看某個 commit 當時的檔案內容
git show abc1234:src/app.js

# 逐行查看最後是誰、在哪個 commit 修改的
git blame src/app.js

# 只看第 10～20 行
git blame -L 10,20 src/app.js
```

### 查看差異（Diff）

```bash
# 查看工作區與暫存區的差異
git diff

# 查看暫存區與上次 commit 的差異
git diff --staged

# 比較兩個分支目前的內容（等同 git diff main feature/login）
git diff main..feature/login

# 只看 feature/login 從分岔點之後改了什麼（review PR 時看這個）
git diff main...feature/login

# 查看特定檔案的差異
git diff -- src/app.js

# 只看檔案名稱（哪些檔案被修改）
git diff --name-only
```

兩點、三點在 log 和 diff 的意思不一樣：`git log main..feature/login` 是「feature/login 多出來的 commit」，對應的內容差異是 `git diff main...feature/login`（三點）。兩點的 `git diff main..feature/login` 會連 main 後來的新修改都算進去，看起來像 feature 把那些修改刪掉了。

---

## 10. 撤銷與回復

### 撤銷工作區的修改

```bash
# 捨棄單一檔案的修改（回到上次 commit 的狀態）
git checkout -- src/app.js

# Git 2.23+ 推薦用法
git restore src/app.js

# 捨棄所有檔案的修改
git restore .
```

`restore` 只處理已追蹤的檔案。新增、還沒加入過 Git 的檔案要用 `clean` 刪除：

```bash
# 先預覽會刪除哪些檔案
git clean -n

# 刪除未追蹤的檔案與資料夾（被 .gitignore 忽略的不會刪）
git clean -fd
```

### 取消暫存（Unstage）

```bash
# 將檔案從暫存區移回工作區
git reset HEAD src/app.js

# Git 2.23+ 推薦用法
git restore --staged src/app.js
```

### 回退 Commit

```bash
# 軟重置：回退 commit 但保留修改在暫存區
git reset --soft HEAD~1

# 混合重置（預設）：回退 commit，修改保留在工作區
git reset HEAD~1

# 硬重置：回退 commit 並丟棄所有修改（危險！）
git reset --hard HEAD~1

# 回退到特定 commit
git reset --hard abc1234
```

`--hard` 會把工作區還沒 commit 的修改一起丟掉，這部分連 reflog 都救不回來，執行前先用 `git status` 確認。被 reset 掉的 commit 則還找得回來（見第 13 節情境 6）。

### 安全回退：Revert

```bash
# 產生一個新的 commit 來「反轉」指定 commit 的變更
# 不會改寫歷史，適合已推送的分支
git revert abc1234

# 反轉最近一次 commit
git revert HEAD

# 反轉多個 commit（不自動 commit，最後一次提交）
git revert --no-commit HEAD~3..HEAD
git commit -m "revert: 回退最近三次變更"

# 反轉 merge commit 要用 -m 指定以哪一邊為主
# -m 1 代表保留合併時所在的分支（通常是 main），撤掉被合併進來的修改
git revert -m 1 abc1234
```

merge commit 有兩個 parent，Git 不知道要退回哪一邊，沒加 `-m` 會直接報錯：

```
error: commit abc1234 is a merge but no -m option was given.
fatal: revert failed
```

### Reset vs Revert

| 特性 | Reset | Revert |
|------|-------|--------|
| 方式 | 移動 HEAD 指標 | 產生新的反轉 commit |
| 歷史 | 改寫歷史 | 不改寫歷史 |
| 適用 | 本地未推送的 commit | 已推送到遠端的 commit |
| 安全性 | 較低 | 較高 |

---

## 11. 標籤管理

```bash
# 建立輕量標籤
git tag v1.0.0

# 建立附註標籤（推薦，包含更多資訊）
git tag -a v1.0.0 -m "正式版 1.0.0 發布"

# 對特定 commit 建立標籤
git tag -a v1.0.0 abc1234 -m "正式版 1.0.0"

# 查看所有標籤
git tag

# 推送標籤到遠端
git push origin v1.0.0

# 推送所有標籤
git push origin --tags

# 刪除本地標籤
git tag -d v1.0.0

# 刪除遠端標籤
git push origin --delete v1.0.0
```

---

## 12. Cherry Pick

**情境：只想把某個分支的特定 commit 搬到目前分支**

```bash
# 挑選單一 commit
git cherry-pick abc1234

# 挑選多個 commit
git cherry-pick abc1234 def5678

# 挑選但不自動 commit（先暫存起來）
git cherry-pick --no-commit abc1234

# 遇到衝突時
git cherry-pick abc1234
# 解決衝突後
git add .
git cherry-pick --continue

# 放棄 cherry-pick
git cherry-pick --abort
```

**實際情境：hotfix 同時需要套用到 main 和 develop**

```bash
# 在 hotfix 分支修好 bug 並 commit
git checkout hotfix/fix-crash
git commit -m "fix: 修正應用程式閃退問題"
# 假設此 commit 為 abc1234

# 切到 main 套用
git checkout main
git cherry-pick abc1234

# 切到 develop 也套用
git checkout develop
git cherry-pick abc1234
```

---

## 13. 常見情境與解決方案

### 情境 1：不小心 commit 到錯誤的分支

```bash
# 假設不小心在 main 上 commit 了（還沒 push），想移到 feature 分支

# 1. 記住 commit hash
git log -1
# 假設為 abc1234

# 2. 確認沒有其他未 commit 的修改，再回退 main（--hard 會丟掉未 commit 的修改）
git status
git reset --hard HEAD~1

# 3. 切到正確的分支，cherry-pick 過去
git checkout feature/my-feature
git cherry-pick abc1234
```

如果要放的分支還不存在，直接在目前位置開分支更簡單，commit 會留在新分支上：

```bash
git branch feature/my-feature   # 在目前的 commit 建立分支
git reset --hard HEAD~1         # main 退回前一個 commit
git switch feature/my-feature
```

如果已經 push 到遠端的 main，就不要 reset，改用 `git revert` 產生反轉 commit（見第 10 節），再到正確的分支重新 commit。

### 情境 2：想把遠端分支拉到本地

```bash
# 先取得遠端資訊
git fetch origin

# 建立本地分支並追蹤遠端分支
git checkout -b feature/login origin/feature/login

# 或者簡寫（如果本地沒有同名分支）
git checkout feature/login
```

### 情境 3：合併多個 commit 為一個（Squash Merge）

```bash
# 在 main 上用 squash 方式合併 feature 分支
git checkout main
git merge --squash feature/login
git commit -m "feat: 完成登入功能"

# 這樣 feature 分支上的所有 commit 會被壓縮成一個
```

Squash merge 產生的是一個全新的 commit，Git 不會記錄 feature/login 已經合併。之後 `git branch -d feature/login` 會拒絕刪除：

```
error: The branch 'feature/login' is not fully merged.
```

確認內容已經在 main 上之後，改用 `git branch -D feature/login`。GitHub 的 Squash and merge、Rebase and merge 也是一樣的情況。

### 情境 4：找出是哪個 commit 引入了 bug

```bash
# 使用 bisect 二分搜尋法
git bisect start
git bisect bad              # 目前版本有 bug
git bisect good v1.0.0      # 這個版本沒有 bug

# Git 會自動 checkout 中間的 commit，你測試後回報：
git bisect good   # 這個版本沒問題
git bisect bad    # 這個版本有 bug

# 重複直到找到引入 bug 的 commit
# 結束 bisect
git bisect reset
```

### 情境 5：清除已追蹤但現在想忽略的檔案

```bash
# 先更新 .gitignore，然後：
# 從 Git 追蹤中移除（但保留本地檔案）
git rm --cached config/secrets.json
git commit -m "chore: 移除敏感設定檔的追蹤"

# 如果要移除整個資料夾
git rm -r --cached node_modules/
```

`git rm --cached` 只讓之後的 commit 不再包含這個檔案，**舊的 commit 裡還是有**，任何能存取倉庫的人都能從歷史中看到。如果含有密碼、金鑰的檔案已經推上遠端：

1. 先到對應的服務撤銷這組密鑰並換一組新的。這一步最重要，因為你無法確定有沒有人已經拿到。
2. 需要從歷史中徹底移除時，用 [git filter-repo](https://github.com/newren/git-filter-repo) 改寫歷史，然後強制推送，並請所有協作者重新 clone：

```bash
git filter-repo --path config/secrets.json --invert-paths
```

### 情境 6：回復已刪除的分支

```bash
# 查看 reflog 找到分支最後的 commit
git reflog

# 從 reflog 中的 commit hash 重建分支
git checkout -b recovered-branch abc1234
```

剛用 `git branch -D` 刪掉的話，輸出的 `Deleted branch feature/login (was abc1234).` 括號裡就是要找的 hash。reflog 只存在本機，而且會過期（不屬於任何分支的紀錄預設保留 30 天），要盡早處理。

### 情境 7：同步 Fork 的上游倉庫

```bash
# 新增上游倉庫
git remote add upstream https://github.com/original/repo.git

# 拉取上游最新程式碼
git fetch upstream

# 合併上游的 main 到本地 main
git checkout main
git merge upstream/main

# 推送到自己的 fork
git push origin main
```

### 情境 8：暫時切換到某個歷史 commit 查看

```bash
# 切換到特定 commit（進入 detached HEAD 狀態）
git switch --detach abc1234     # 或 git checkout abc1234

# 想從這個 commit 開新分支，要在回到 main 之前執行
git switch -c new-branch-from-old-commit

# 查看完後回到分支
git switch main
```

不需要先切換過去，也可以直接從指定的 commit 開分支：`git switch -c new-branch-from-old-commit abc1234`。

---

## 附錄：Git Commit 訊息規範

建議使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

常用 type：

| Type | 說明 |
|------|------|
| `feat` | 新功能 |
| `fix` | 修復 Bug |
| `docs` | 文件修改 |
| `style` | 程式碼風格（不影響邏輯） |
| `refactor` | 重構（非新功能、非修 Bug） |
| `test` | 測試相關 |
| `build` | 建置系統或外部依賴（例如 vite 設定、升級 npm 套件） |
| `chore` | 不影響程式碼與測試的雜項（例如更新 .gitignore） |
| `perf` | 效能優化 |
| `ci` | CI/CD 設定變更 |
| `revert` | 回退先前的 commit |

範例：

```
feat(auth): 新增 Google OAuth 登入功能

- 整合 Google OAuth 2.0 API
- 新增登入回調處理
- 建立使用者 session

Closes #42
```

`Closes #42` 寫在 commit 或 PR 描述裡，合併到預設分支後 GitHub 會自動關閉 #42 這個 Issue。

不相容的變更（使用者升級後要跟著改），在 type 後面加 `!`，並在 footer 說明：

```
feat(api)!: 移除 v1 登入 API

BREAKING CHANGE: /api/v1/login 已移除，請改用 /api/v2/login
```

---

## 附錄：常用 Git Alias 設定

```bash
git config --global alias.st "status"
git config --global alias.co "checkout"
git config --global alias.br "branch"
git config --global alias.ci "commit"
git config --global alias.lg "log --oneline --graph --all --decorate"
git config --global alias.unstage "restore --staged"
git config --global alias.last "log -1 HEAD"
git config --global alias.amend "commit --amend --no-edit"
```

設定完後可以使用簡寫：

```bash
git st          # git status
git co main     # git checkout main
git br -a       # git branch -a
git lg          # 美化版 log
```
