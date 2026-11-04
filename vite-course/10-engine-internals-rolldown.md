# 第 10 章:引擎內幕與 Rolldown 遷移

> 全課從第 00 章開始,反覆提一件事:Vite 2～7 是「dev 用 esbuild、build 用 Rollup」的**雙引擎**,而 2026 年 3 月的 Vite 8 把它換成了 Rolldown + Oxc。
> 這一章把這個設計的**取捨、代價、與演進**做總收束。
> 我們會回答:為什麼當初要用兩套不同的工具?它們行為不一致會造成什麼問題?
> Vite 團隊為什麼要用 Rust 寫一個新引擎 **Rolldown** 來統一兩者?從 Vite 7 升級到 8 要改什麼?
> 它跟 **esbuild**、**Turbopack** 的競合關係是什麼?學完這章,你會理解 Vite 正在往哪裡走、以及背後的工程哲學。

---

## 10.1 回顧:Vite 為什麼曾是「雙引擎」

先把 Vite 2～7 的引擎觀念收攏成一張圖:

```
                 Vite 2～7
        ┌────────────┴────────────┐
     dev(開發)                build(生產)
        │                         │
   ┌────┴─────┐              ┌─────┴─────┐
 esbuild    瀏覽器          Rollup
 (即時轉譯   原生 ESM      (打包、tree shaking、
  + 預打包)  (不打包)        code splitting、壓縮)
```

- **dev 用 esbuild + 原生 ESM**(第 02~04 章):因為要「快」——啟動快、改動即時。esbuild 用 Go 寫,快 10~100 倍,適合「即時轉譯」「預打包」這種要趕快做完的工作。dev 不需要極致最佳化(本機跑,不在乎體積)。
- **build 用 Rollup**(第 08 章):因為要「精」——tree shaking、code splitting、穩定的產物、成熟的 plugin 生態。生產品質的打包,Rollup 比當時的 esbuild 成熟太多。

**這個搭配在 2020 年是絕配**:各取所長,讓 Vite 同時擁有「dev 飛快」和「build 高品質」。這是 Vite 能崛起的核心設計。

---

## 10.2 雙引擎的代價:行為不一致

但「兩套不同工具」必然有一個根本代價,這也是 Vite 7 以前「**dev 沒事、build 卻出錯**」最主要的根源:

> **esbuild 和 Rollup 是兩個獨立開發的工具,對同樣的程式碼,處理方式和結果可能有細微差異。**

具體會在哪裡咬到你(把前面章節的伏筆全部收齊):

| 不一致來源 | 章節 | 症狀 |
|-----------|------|------|
| CJS/ESM 互通處理:esbuild 預打包 vs Rollup 的 commonjs plugin | 03、08 | 某 CJS 套件 dev 正常,build 後 import 出錯 |
| 依賴解析:dev 預打包過 vs build 走 Rollup 解析 | 03 | 某依賴在兩階段被解析成不同東西 |
| 語法轉換的細節差異 | 04、08 | 邊緣語法在兩邊轉出的結果不同 |
| plugin 執行者不同:dev 是 Vite 的 plugin container vs build 是 Rollup | 06、07 | 同一 plugin 兩階段行為不同 |

**為什麼這很惱人?** 因為 dev 是你 90% 時間待的地方,你會「以為沒問題」,結果 build 才爆——而且 build 的錯通常更難 debug(產物被壓縮過、不是你寫的原樣)。第 08 章教你的「上線前一定 `build` + `preview`」就是為了對抗這個代價。

> **心智模型**:雙引擎像「一個團隊用兩種語言溝通」——平時(dev)講一種、正式場合(build)講另一種。大部分時候意思一樣,但偶爾翻譯有出入,就出包了。要根治,只有一個辦法:**讓兩邊講同一種語言**——這就是 Rolldown 的動機。
>
> 要注意的是,統一工具只消除了「工具不同」這一類差異。dev 不打包、build 打包,這兩條路徑本身仍然不同(第 08 章 8.8 的表裡,大部分原因跟工具無關),所以「上線前先 build + preview」的習慣在 Vite 8 依然重要。

---

## 10.3 Rolldown:用 Rust 統一兩個引擎

### 它是什麼

**Rolldown** 是 VoidZero(尤雨溪創立、維護 Vite 的公司)用 **Rust** 開發的新一代打包器。它的同門兄弟是 **Oxc**:一套同樣用 Rust 寫的 JS/TS 工具鏈,負責解析、轉譯(剝型別、轉 JSX)與壓縮。Rolldown 內部就是用 Oxc 解析程式碼。一句話定位:

> **Rolldown = 「Rollup 的 API/生態相容」+「esbuild 等級的速度(Rust 原生)」。Vite 8 起,它同時取代了 dev 預打包用的 esbuild 和 build 用的 Rollup;TS/JSX 轉譯與 JS 壓縮則交給 Oxc。Vite 回歸「單一工具鏈」。**

### 為什麼是 Rust?

回憶第 00 章:esbuild 快,是因為用 Go(編譯成原生機器碼、多核心平行),而 Rollup/Babel 慢,是因為用 JS(單執行緒、解譯/JIT)。

Rust 跟 Go 一樣是編譯成原生機器碼的系統語言,而且:

- **沒有 GC(垃圾回收)停頓**:記憶體由所有權系統管理,效能更可預測。
- **極致的效能與記憶體安全**:適合寫「要處理海量模組、又不能出錯」的打包器。

近年前端工具鏈大舉「Rust 化」(esbuild 是 Go,但更新的 SWC、Turbopack、Biome、Rolldown 都是 Rust),就是為了突破「JS 工具處理大型專案太慢」的天花板。

### Rolldown 解決什麼(對照 10.2 的代價)

```
Vite 2～7(雙引擎):
  dev   → 原生 ESM(不打包)+ esbuild 轉譯 + esbuild 預打包
  build → Rollup
  問題:兩套工具,行為不一致 → 「dev 沒事 build 出錯」

Vite 8 起(Rolldown + Oxc 統一):
  dev   → 原生 ESM(不打包)+ Oxc 轉譯 + Rolldown 預打包
  build → Rolldown(內含 Oxc 轉譯與壓縮)
  好處:同一套工具 → dev 和 build 處理程式碼的方式一致 → 大幅減少「dev/build 不一致」的坑
        而且 build 速度因 Rust 大幅提升(官方宣稱快 10～30 倍,實際幅度看專案)
```

注意 dev **仍然不打包**:第 02 章的 No-bundle 架構沒變,換掉的是底下的轉譯器與預打包器。

**兩個核心收益**:

1. **一致性**:dev 預打包和 build 用同一個打包器,10.2 表格裡「工具不同」造成的那幾類問題大幅減少。
2. **速度**:把 build(原本用 JS 寫的 Rollup,大型專案很慢)換成 Rust,build 速度大躍進。dev 端也因為「真的有個快速 bundler」多了新選項:實驗性的 **Full Bundle Mode**(第 02 章)讓 dev 也能打包,專門解決超大型專案請求數太多的問題。

### 現況:Vite 8 已經把它設為預設(2026 年)

- **時間線**:Vite 7 時代先推出 `rolldown-vite` 套件讓大家試用;2026 年 3 月 12 日發布的 **Vite 8** 正式把 Rolldown + Oxc 設為預設,esbuild 與 Rollup 不再是 Vite 的必要依賴。
- **對你的影響:大部分專案幾乎無感**。Vite 8 內建相容層,會自動把舊的 `esbuild`、`rollupOptions` 等設定轉成新的對應選項,只印出棄用警告;Rolldown 實作了 Rollup 相容的 plugin API,大部分 plugin 不用改。它換的是「引擎」,不是「方向盤」。
- **你該做的**:新專案直接用 Vite 8;舊專案升級後,照著終端機的棄用警告,把設定改成新名稱(見下一節)。

### 從 Vite 7 升級到 Vite 8:要改什麼

Node 版本要求跟 Vite 7 一樣(20.19+ / 22.12+),不用動。常見要改的設定:

| Vite 7 寫法 | Vite 8 寫法 | 說明 |
|------------|------------|------|
| `build.rollupOptions` | `build.rolldownOptions` | 舊名仍可用,已棄用 |
| `output.manualChunks` | `output.codeSplitting` | 物件寫法已移除、函式寫法已棄用(第 08 章) |
| `esbuild`(例如 `esbuild.jsxInject`、`esbuild.define`) | `oxc`(`oxc.jsxInject`、`oxc.define`) | 會自動轉換;`esbuild.banner` / `footer` 要改用 plugin |
| `optimizeDeps.esbuildOptions` | `optimizeDeps.rolldownOptions` | 會自動轉換 |
| `build.minify: 'esbuild'` | 預設 `'oxc'` | 想沿用 esbuild 得自己安裝 esbuild(已棄用) |
| CSS 壓縮用 esbuild | 預設 Lightning CSS | `build.cssMinify: 'esbuild'` 可切回 |
| `build.commonjsOptions` | 不再有作用 | CJS 由 Rolldown 原生處理 |

另外幾個行為改變:

- **預設 `build.target` 提高**到 Chrome / Edge 111、Firefox 114、Safari 16.4。
- **CJS 預設匯入的互通規則調整**:`import x from 'cjs-pkg'` 拿到的是 `module.exports` 還是 `module.exports.default`,規則跟以前不同。遇到預設匯入變成 `undefined` 或多包一層,先查這點;可用 `legacy.inconsistentCjsInterop: true` 暫時恢復舊行為。
- **plugin-legacy 不再支援轉成 ES5**;輸出格式也不再支援 `system` 與 `amd`。

> **回扣全課**:第 00 章我說「Vite 的引擎還在演化中」,現在你懂了完整的故事——雙引擎是務實的起點,但有一致性的代價;Rolldown + Oxc 是用 Rust 把兩個引擎合一的收束,而且已經在 Vite 8 落地。這是一個「先用組合拳解決問題、再用更強的單一武器收束」的經典工程演進。

---

## 10.4 競品對照:esbuild / Rollup / Rolldown / Turbopack / Webpack

把市面上主要的建構工具放在一起對照,幫你建立完整的版圖。**重點不是背規格,而是理解「每個工具的定位與取捨」**。

| 工具 | 語言 | 定位 | 強項 | 弱項 / 取捨 |
|------|------|------|------|------------|
| **Webpack** | JS | 老牌全能打包器 | 生態最大、最成熟、功能最全 | dev 慢、設定複雜(第 00 章) |
| **esbuild** | Go | 極速轉譯/打包器 | 快到誇張 | 生產級打包功能(splitting/CSS)較陽春 |
| **Rollup** | JS | 高品質打包器 | tree shaking、產物乾淨、plugin 生態好 | 純 JS,大型專案 build 慢 |
| **Vite** | (整合工具鏈) | dev server + 建構工具 | dev 飛快、體驗好、生態爆發 | dev 不打包 vs build 打包仍有差異;超大型專案 dev 請求數多 |
| **Rolldown** | Rust | Vite 8 的預設 bundler | Rollup 相容 + Rust 速度 | 少數冷門 Rollup hook 不支援,周邊生態仍在補齊 |
| **Oxc** | Rust | 解析 / 轉譯 / 壓縮工具鏈 | 速度快,Vite 8 的 TS/JSX 轉譯與 JS 壓縮都用它 | 不會把原生 decorator 降級,需要時得另配 Babel / SWC |
| **Rspack** | Rust | 相容 Webpack 的 Rust 打包器 | 能沿用 Webpack 的設定與 loader,遷移成本低 | 架構仍是 Webpack 式的「先打包」 |
| **Turbopack** | Rust | Vercel 的 Webpack 接班人 | 主打增量計算、極速、深度整合 Next.js | 主要綁 Next.js 生態 |

幾個值得記住的關係:

- **Vite vs Webpack**:Vite 的 dev 體驗(秒啟動、即時 HMR)是它打贏 Webpack 的關鍵,根源就是第 02 章「dev 不打包」。Webpack 後來也加了類似機制,但 Vite 從架構上就是為此而生。
- **Vite vs Turbopack**:兩者是當代「下一代建構工具」的兩條路線。Turbopack 深度綁定 Next.js/Vercel 生態,主打「增量計算」(只重算真正變動的部分);Vite 走「框架中立 + Rolldown 統一引擎」路線,生態更開放(Nuxt、SvelteKit、Astro 等都建在 Vite 上)。
- **esbuild、Rollup 不是「被淘汰」**:Vite 8 不再依賴它們,但 esbuild 仍是頂尖的轉譯器、被無數工具當底層;Rollup 仍是打包品質標竿,Rolldown 本身就是「Rollup 精神的 Rust 重寫」。它們的設計思想活在新工具裡。

> **給你的判斷框架**:選建構工具時,別追「哪個最快」,要問「**我的場景在意什麼**」(第 08 章「先測量再優化」的同款思維):
> - 要 dev 體驗 + 框架中立 → Vite。
> - 重度 Next.js → Next.js 內建的 Turbopack。
> - 要打包一個底層工具、要極致控制 → 直接用 Rollup/esbuild。
> - 維護老專案 → Webpack 也沒什麼不好,別為換而換。

---

## 10.5 從演進史看工程哲學(總收束)

這一章其實是全課「建構工具演進史」(第 00 章)的閉環。把整條線重看一次,你會看到一個反覆出現的工程智慧:

```
痛點 → 解法 → 解法帶來新代價 → 更好的解法收束

裸寫 <script>(全域污染、請求多)
   → 模組系統 + Webpack(統一打包)
      → Webpack dev 慢
         → Vite 雙引擎(dev 不打包 + build 用 Rollup,飛快)
            → 雙引擎行為不一致
               → Rolldown + Oxc(Rust 單一工具鏈,一致 + 快;Vite 8 落地)
                  → 原始碼多到上千模組時,dev 請求數成為新瓶頸
                     → Full Bundle Mode(dev 也打包,實驗中)……下一個代價?
```

**幾個能帶走的、超越 Vite 本身的觀念**:

1. **沒有銀彈,只有取捨**:Vite 雙引擎不是「設計缺陷」,是當年「在現有材料下的最佳務實組合」。工程是在約束下做取捨,不是追求理論完美。
2. **約束會變,設計也該變**:當 Rust 讓「又快又統一的 bundler」變得可能,雙引擎的取捨就不再划算,於是有 Rolldown。**好的架構會隨著底層能力的變化而演進**,抱著舊設計不放才是問題。
3. **理解「為什麼」比記住「怎麼用」值錢**:API 會變(`vite.config` 的選項、Rolldown 的細節都會變),但「為什麼 dev 不打包」「為什麼要預打包」「為什麼雙引擎有代價」這些原理,十年都不會過時。這正是本課程從第 00 章就強調「建立心智模型而非背 API」的原因。

> **最後一個心智模型(送給你的)**:讀任何新工具的文件時,別只看「它能做什麼」,要問三個問題——**它解決了上一代的什麼痛?它的解法帶來什麼新代價?它在什麼場景下不划算?** 能回答這三個,你就不是「會用工具的人」,而是「懂工具的人」。這也是這門課真正想教你的東西。

---

## 10.6 本章小結與下一步

這一章把全課的引擎主線做了總收束:

- **雙引擎回顧**:Vite 2～7 的 dev 用 esbuild(快)、build 用 Rollup(精),2020 年的務實絕配。
- **雙引擎的代價**:兩套工具行為不一致,是 Vite 7 以前「dev 沒事 build 出錯」的主要根源(把 03/04/06/07/08 章的伏筆全收齊)。
- **Rolldown + Oxc**:用 Rust 寫的新 bundler 與工具鏈,「Rollup 相容 + esbuild 速度」,在 Vite 8 統一了 dev 預打包與 build——解決一致性 + 大幅加速 build。dev 仍不打包。對大部分使用者「幾乎無感」,換的是引擎不是方向盤。
- **升級 Vite 8**:`rollupOptions` → `rolldownOptions`、`manualChunks` → `codeSplitting`、`esbuild` → `oxc` 等;相容層會自動轉換並提示。
- **競品版圖**:Webpack/esbuild/Rollup/Vite/Rolldown/Oxc/Rspack/Turbopack 的定位與取捨;選工具看「場景在意什麼」而非「誰最快」。
- **工程哲學**:沒有銀彈只有取捨、約束變則設計變、懂「為什麼」勝過記「怎麼用」。

**下一章(11)是 capstone**:我們把第 02~05 章的核心機制——**dev server + 原生 ESM + 即時轉譯 + 依賴預打包 + HMR**——親手實作成一個「mini-vite」。第 05 章結尾就預告過:前四章學的剛好就是手寫 mini-vite 需要的全部。現在,我們要把理論變成幾百行能跑的程式碼,讓你對 Vite 的理解從「看懂」升級到「做得出來」。

> 💡 **思考作業**(這章偏觀念,作業也偏思考):① 用你自己的話,跟一個沒學過的人解釋「為什麼 Vite 要用兩個引擎,以及它為什麼又想合成一個」。能講清楚,代表你真的懂了。② 去翻一篇 Vite 或 Rolldown 的官方 blog / release note,試著用 10.5 的「三個問題」(解決什麼痛、什麼新代價、什麼場景不划算)去拆解它。
