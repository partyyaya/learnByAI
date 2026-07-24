# 第十四章：TypeScript Compiler API

> 本章屬於進階補充章節。它探討的是「用程式操作 TypeScript 編譯器本身」，屬於工具開發者的領域。若你的目標是寫應用程式，這章可以當作視野拓展；若你想開發 lint 規則、codemod、程式碼產生器，這章是必修。

## 14.1 什麼是 Compiler API？

`tsc` 這個編譯器本身就是用 TypeScript 寫成的，而且它把內部能力透過 `typescript` 這個 npm 套件**完整公開**出來。也就是說，你安裝的 `typescript` 不只是命令列工具，還是一個可以在程式裡 `import` 的函式庫，讓你能夠：

- **解析原始碼**成 AST（抽象語法樹），走訪、分析每個語法節點。
- **取得型別資訊**：問編譯器「這個變數的型別是什麼？」「這個符號從哪來？」
- **執行型別檢查**、收集診斷訊息（等於自己做一個 mini `tsc`）。
- **轉換程式碼**：修改 AST 後重新輸出（codemod、自動重構）。
- **產生程式碼**：從零建立 AST 節點並印成字串。

### 典型應用場景

| 場景 | 說明 | 相關工具 |
|------|------|----------|
| Linter | 分析程式碼、找出違反規則之處 | typescript-eslint |
| Codemod | 大規模自動修改程式碼 | jscodeshift、ts-morph |
| 程式碼產生 | 從 schema/型別產生程式碼 | tRPC、Prisma、GraphQL Codegen |
| 文件產生 | 從型別與註解抽出 API 文件 | TypeDoc |
| 型別轉換 | TS 型別 → JSON Schema / Zod | ts-to-zod、typescript-json-schema |
| 打包工具外掛 | 自訂編譯期轉換 | ts-loader、ttypescript |

> ⚠️ 重要提醒：`ts` 這個命名空間**沒有 semver 穩定的公開介面**。官方並不承諾小版本升級時 API 形狀不變——`SyntaxKind` 成員、內部型別的結構、甚至某些函式簽章都可能在 minor 版之間調整，這是社群長期以來公認的「移動標靶」。因此，直接依賴 Compiler API 開發的工具，`package.json` 應該**鎖定明確版本**（如 `"typescript": "5.9.3"`），而不是用 `^5.9.3` 這種 caret range，並在升級 `typescript` 時把它當成一次需要重新測試的變更，而非單純的 patch 更新。

---

## 14.2 核心概念與架構

在寫任何程式之前，先建立整體心智模型。Compiler API 有幾個核心角色：

```
                 ┌─────────────────────────────────────────┐
   原始碼字串 ──▶ │  SourceFile（AST 根節點）                 │
                 │    └─ Node（每個語法結構都是一個節點）      │
                 └─────────────────────────────────────────┘
                                    │
   一組檔案 + 設定 ──▶  ┌──────────────────────┐
                       │  Program（整個編譯專案）│
                       │    └─ TypeChecker      │──▶ 型別資訊、診斷
                       └──────────────────────┘
                                    │
                       ┌──────────────────────┐
                       │  Transformer + Printer│──▶ 修改後的原始碼
                       └──────────────────────┘
```

- **Node（節點）**：AST 的基本單位。每個 `if`、每個函式、每個識別字都是一個 `Node`。所有節點都有一個 `kind` 屬性標示種類。
- **SourceFile**：一個 `.ts` 檔案對應一個 SourceFile，它是該檔案 AST 的根節點。
- **SyntaxKind**：一個列舉（enum），列出所有節點種類（`FunctionDeclaration`、`Identifier`、`CallExpression`…）。
- **Program**：代表「一次完整的編譯」，包含所有原始檔、編譯選項，以及跨檔案的資訊。**只有透過 Program 才能取得型別資訊**（單一 SourceFile 只有語法、沒有語意）。
- **TypeChecker**：從 Program 取得，負責回答所有「型別語意」問題：符號解析、型別推導、相容性、診斷。
- **Transformer / Printer**：修改 AST（Transformer）、把 AST 印回字串（Printer）。

> 🔑 最重要的觀念：**語法（syntax）vs 語意（semantics）**。
> 只建 SourceFile 你能知道「這裡有一個叫 `foo` 的變數宣告」（語法），但要知道「`foo` 的型別是 `number`」則需要 TypeChecker（語意），而 TypeChecker 只能從 Program 拿到。

---

## 14.3 環境設定

```bash
# 只需要安裝 typescript 本身，Compiler API 就在裡面
npm install typescript
npm install -D @types/node   # 需要用到 process、fs 等 Node API

# 執行 .ts 腳本（擇一）
npm install -D tsx           # 推薦，零設定
npx tsx script.ts
# 或
npx ts-node script.ts
```

```typescript
// 所有 API 都掛在 ts 這個命名空間下
import * as ts from "typescript";

console.log(ts.version); // 例如 "5.4.5"
```

> 💡 想快速看某段程式對應的 AST 長什麼樣，可以用線上工具 [TypeScript AST Viewer](https://ts-ast-viewer.com/)（貼上程式碼即可看到節點樹與對應的 `SyntaxKind`、`factory` 產生程式碼），這是開發 Compiler API 時最實用的輔助工具。

---

## 14.4 建立 SourceFile 與走訪 AST

最基礎的操作：把一段原始碼字串解析成 AST，然後遞迴走訪每個節點。這一步**不需要**檔案系統，也不需要 Program。

```typescript
import * as ts from "typescript";

const code = `
const greeting: string = "Hello";
function add(a: number, b: number): number {
  return a + b;
}
`;

// 第 4 個參數 setParentNodes = true，讓每個節點都有 parent 指標，
// 也才能安全呼叫 node.getText() 等需要來源檔的方法
const sourceFile = ts.createSourceFile(
  "example.ts",
  code,
  ts.ScriptTarget.Latest,
  /* setParentNodes */ true,
);

// 遞迴走訪：印出每個節點的種類與縮排層級
function printNode(node: ts.Node, depth = 0): void {
  const kindName = ts.SyntaxKind[node.kind]; // 把數字 kind 轉成可讀名稱
  const indent = "  ".repeat(depth);
  console.log(`${indent}${kindName}`);
  // forEachChild 只走訪「語法上有意義」的子節點（會略過標點等 token）
  node.forEachChild((child) => printNode(child, depth + 1));
}

printNode(sourceFile);
/*
SourceFile
  FirstStatement            <- const 宣告
    VariableDeclarationList
      VariableDeclaration
        Identifier          <- greeting
        StringKeyword       <- : string
        StringLiteral       <- "Hello"
  FunctionDeclaration
    Identifier              <- add
    Parameter ...
  EndOfFileToken
*/
```

### 用型別守衛函式判斷節點種類

`ts` 提供大量 `ts.isXxx()` 型別守衛，比手動比對 `node.kind === ts.SyntaxKind.Xxx` 更安全，還能自動縮窄型別：

```typescript
import * as ts from "typescript";

const sourceFile = ts.createSourceFile(
  "example.ts",
  `const a = 1; function foo() {} const b = 2;`,
  ts.ScriptTarget.Latest,
  true,
);

const functionNames: string[] = [];
const variableNames: string[] = [];

function visit(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name) {
    // 這個區塊內，node 的型別已被縮窄為 FunctionDeclaration
    functionNames.push(node.name.text);
  } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    variableNames.push(node.name.text);
  }
  ts.forEachChild(node, visit);
}

visit(sourceFile);
console.log("函式：", functionNames); // ["foo"]
console.log("變數：", variableNames); // ["a", "b"]
```

---

## 14.5 使用 Program 與 TypeChecker 取得型別資訊

要問「型別」相關的問題，就必須建立 Program。以下範例假設同目錄有一個 `sample.ts` 檔案。

```typescript
// analyze.ts
import * as ts from "typescript";

// 1. 建立 Program（傳入進入點檔案與編譯選項）
const program = ts.createProgram(["sample.ts"], {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.CommonJS,
  strict: true,
});

// 2. 從 Program 取得 TypeChecker
const checker = program.getTypeChecker();

// 3. 走訪原始檔（略過 .d.ts 宣告檔與 node_modules）
for (const sourceFile of program.getSourceFiles()) {
  if (sourceFile.isDeclarationFile) continue;
  if (sourceFile.fileName.includes("node_modules")) continue;
  ts.forEachChild(sourceFile, visit);
}

function visit(node: ts.Node): void {
  // 找出所有函式宣告，印出它的完整簽章
  if (ts.isFunctionDeclaration(node) && node.name) {
    const symbol = checker.getSymbolAtLocation(node.name);
    if (symbol && symbol.valueDeclaration) {
      const type = checker.getTypeOfSymbolAtLocation(
        symbol,
        symbol.valueDeclaration,
      );
      // 一個符號可能有多個呼叫簽章（重載）
      for (const signature of type.getCallSignatures()) {
        const params = signature.getParameters().map((p) => {
          const pType = checker.getTypeOfSymbolAtLocation(
            p,
            p.valueDeclaration!,
          );
          return `${p.getName()}: ${checker.typeToString(pType)}`;
        });
        const returnType = checker.typeToString(signature.getReturnType());
        console.log(`${symbol.getName()}(${params.join(", ")}): ${returnType}`);
      }
    }
  }
  ts.forEachChild(node, visit);
}
```

若 `sample.ts` 內容為：

```typescript
// sample.ts
export function add(a: number, b: number): number {
  return a + b;
}
export function greet(name: string): string {
  return `Hi, ${name}`;
}
```

執行 `npx tsx analyze.ts` 會印出：

```
add(a: number, b: number): number
greet(name: string): string
```

### 常用的 TypeChecker 方法

| 方法 | 用途 |
|------|------|
| `getSymbolAtLocation(node)` | 取得某節點對應的符號（Symbol） |
| `getTypeAtLocation(node)` | 取得某節點的型別（Type） |
| `getTypeOfSymbolAtLocation(symbol, node)` | 取得符號在某位置的型別 |
| `typeToString(type)` | 把型別轉成人類可讀字串（如 `"number"`） |
| `getReturnTypeOfSignature(sig)` | 取得簽章回傳型別 |
| `getPropertiesOfType(type)` | 取得型別的所有屬性 |
| `getFullyQualifiedName(symbol)` | 取得符號完整名稱 |

---

## 14.6 型別檢查與診斷：做一個 mini tsc

Compiler API 最直接的用途就是「跑一次編譯、收集所有錯誤」。這也是理解 `tsc` 運作的最佳方式。

```typescript
// mini-tsc.ts
import * as ts from "typescript";

function compile(fileNames: string[], options: ts.CompilerOptions): void {
  const program = ts.createProgram(fileNames, options);
  const emitResult = program.emit(); // 產生 .js（若有錯且 noEmitOnError，會跳過）

  // getPreEmitDiagnostics 會收集語法錯誤 + 型別錯誤
  const allDiagnostics = ts
    .getPreEmitDiagnostics(program)
    .concat(emitResult.diagnostics);

  allDiagnostics.forEach((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      "\n",
    );
    if (diagnostic.file && diagnostic.start !== undefined) {
      const { line, character } = ts.getLineAndCharacterOfPosition(
        diagnostic.file,
        diagnostic.start,
      );
      // 行號、欄號從 0 起算，顯示時 +1
      console.log(
        `${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`,
      );
    } else {
      console.log(message);
    }
  });

  const exitCode = emitResult.emitSkipped ? 1 : 0;
  console.log(`共 ${allDiagnostics.length} 個問題，離開碼 ${exitCode}`);
}

compile(["sample.ts"], {
  noEmitOnError: true,
  noImplicitAny: true,
  strict: true,
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.CommonJS,
});
```

### 讀取專案的 tsconfig.json

上面的編譯選項是寫死的。實務上應該讀取專案既有的 `tsconfig.json`：

```typescript
import * as ts from "typescript";
import * as path from "path";

function loadTsConfig(configPath: string): ts.ParsedCommandLine {
  // 1. 讀取並解析 JSON（會處理註解、尾逗號）
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
    );
  }
  // 2. 展開 extends、glob，解析出實際的檔案清單與正規化後的選項
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
  );
  return parsed;
}

const config = loadTsConfig("./tsconfig.json");
console.log("要編譯的檔案：", config.fileNames);
console.log("編譯選項：", config.options);

// 直接用解析結果建立 Program
const program = ts.createProgram(config.fileNames, config.options);
```

### 更漂亮的錯誤輸出

`tsc` 那種「帶顏色 + 程式碼片段 + 底線」的錯誤格式也有現成 API：

```typescript
import * as ts from "typescript";

const formatHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => ts.sys.newLine,
};

const program = ts.createProgram(["sample.ts"], { strict: true });
const diagnostics = ts.getPreEmitDiagnostics(program);

// 輸出等同於 tsc 的彩色錯誤畫面
console.log(
  ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost),
);
```

---

## 14.7 轉換 AST（Transformer API）

Transformer 讓你在編譯過程中**修改 AST**——這是 codemod 與自訂編譯外掛的核心。一個 transformer 是「接收 context、回傳一個處理 SourceFile 的函式」。

以下範例：**移除所有 `console.log(...)` 呼叫**。

```typescript
// remove-console.ts
import * as ts from "typescript";

const code = `
function greet(name: string) {
  console.log("debug:", name);
  const msg = "Hello, " + name;
  console.log(msg);
  return msg;
}
`;

const sourceFile = ts.createSourceFile(
  "input.ts",
  code,
  ts.ScriptTarget.Latest,
  true,
);

// 判斷一個節點是不是 console.log(...) 的呼叫敘述
function isConsoleLog(node: ts.Node): boolean {
  return (
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    ts.isPropertyAccessExpression(node.expression.expression) &&
    ts.isIdentifier(node.expression.expression.expression) &&
    node.expression.expression.expression.text === "console" &&
    node.expression.expression.name.text === "log"
  );
}

const removeConsoleLog: ts.TransformerFactory<ts.SourceFile> = (context) => {
  return (rootNode) => {
    function visit(node: ts.Node): ts.Node | undefined {
      // 先遞迴處理子節點
      node = ts.visitEachChild(node, visit, context);
      // 回傳 undefined 代表刪除這個節點
      if (isConsoleLog(node)) {
        return undefined;
      }
      return node;
    }
    return ts.visitNode(rootNode, visit) as ts.SourceFile;
  };
};

// 套用轉換
const result = ts.transform(sourceFile, [removeConsoleLog]);
const transformed = result.transformed[0];

// 用 Printer 印回字串
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const output = printer.printFile(transformed);
console.log(output);
result.dispose(); // 記得釋放資源

/*
function greet(name: string) {
    const msg = "Hello, " + name;
    return msg;
}
*/
```

### Transformer 的兩個關鍵 API

- **`ts.visitEachChild(node, visitor, context)`**：對一個節點的所有子節點套用 visitor，回傳「換過子節點的新節點」。這是往下遞迴的正確方式（會妥善保留節點結構）。
- **`ts.visitNode(node, visitor)`**：對單一節點套用 visitor。
- visitor 回傳 `undefined` → 刪除節點；回傳新節點 → 取代原節點；回傳原節點 → 不變。

### 用 factory 修改節點

不只能刪除，也能改寫。以下把所有數字字面值 `+1`：

```typescript
import * as ts from "typescript";

const incrementNumbers: ts.TransformerFactory<ts.SourceFile> = (context) => {
  const { factory } = context; // 建議用 context.factory
  return (rootNode) => {
    function visit(node: ts.Node): ts.Node {
      if (ts.isNumericLiteral(node)) {
        const value = Number(node.text) + 1;
        return factory.createNumericLiteral(value);
      }
      return ts.visitEachChild(node, visit, context);
    }
    return ts.visitNode(rootNode, visit) as ts.SourceFile;
  };
};
```

---

## 14.8 從零產生程式碼（Code Generation）

`ts.factory` 提供上百個 `createXxx` 方法，可以完全用程式建構 AST，再用 Printer 印成字串。以下從一份欄位定義產生 TypeScript `interface`。

```typescript
// codegen.ts
import * as ts from "typescript";

interface FieldDef {
  name: string;
  type: "string" | "number" | "boolean";
  optional?: boolean;
}

function generateInterface(name: string, fields: FieldDef[]): string {
  const factory = ts.factory;

  // 型別關鍵字對照
  const typeKeyword = {
    string: ts.SyntaxKind.StringKeyword,
    number: ts.SyntaxKind.NumberKeyword,
    boolean: ts.SyntaxKind.BooleanKeyword,
  } as const;

  // 為每個欄位建立一個屬性簽章
  const members = fields.map((field) =>
    factory.createPropertySignature(
      undefined, // modifiers
      factory.createIdentifier(field.name),
      field.optional
        ? factory.createToken(ts.SyntaxKind.QuestionToken)
        : undefined,
      factory.createKeywordTypeNode(typeKeyword[field.type]),
    ),
  );

  // 建立 export interface 宣告
  const interfaceDecl = factory.createInterfaceDeclaration(
    [factory.createModifier(ts.SyntaxKind.ExportKeyword)],
    factory.createIdentifier(name),
    undefined, // 型別參數
    undefined, // 繼承子句
    members,
  );

  // 用 Printer 印成字串（需要一個空的 SourceFile 當容器）
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const resultFile = ts.createSourceFile(
    "generated.ts",
    "",
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  return printer.printNode(
    ts.EmitHint.Unspecified,
    interfaceDecl,
    resultFile,
  );
}

const output = generateInterface("User", [
  { name: "id", type: "number" },
  { name: "name", type: "string" },
  { name: "email", type: "string", optional: true },
]);

console.log(output);
/*
export interface User {
    id: number;
    name: string;
    email?: string;
}
*/
```

> 💡 手寫 `factory.createXxx` 很繁瑣。實務技巧：在 [ts-ast-viewer.com](https://ts-ast-viewer.com/) 貼上目標程式碼，它會自動幫你產生對應的 `factory` 建構程式，複製回來微調即可。

---

## 14.9 實戰案例

### 案例一：找出所有未被使用的 export

```typescript
// find-unused-exports.ts
import * as ts from "typescript";

function findUnusedExports(fileNames: string[], options: ts.CompilerOptions) {
  const program = ts.createProgram(fileNames, options);
  const checker = program.getTypeChecker();
  const unused: string[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (sourceFile.fileName.includes("node_modules")) continue;

    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) continue;

    // 取得這個模組的所有 export 符號
    for (const exp of checker.getExportsOfModule(moduleSymbol)) {
      const decl = exp.declarations?.[0];
      if (!decl) continue;
      // findAllReferences 需要 LanguageService；此處用簡化示意：
      // 實務上會透過 ts.LanguageService.getReferencesAtPosition 檢查引用數
      const { line } = ts.getLineAndCharacterOfPosition(
        decl.getSourceFile(),
        decl.getStart(),
      );
      console.log(
        `export ${exp.getName()} @ ${decl.getSourceFile().fileName}:${line + 1}`,
      );
    }
  }
  return unused;
}
```

### 案例二：抽取 JSDoc 註解產生 API 文件

```typescript
import * as ts from "typescript";

const code = `
/** 計算兩數之和 */
export function add(a: number, b: number): number {
  return a + b;
}
`;

const sourceFile = ts.createSourceFile("doc.ts", code, ts.ScriptTarget.Latest, true);

function visit(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name) {
    // 取得節點上的 JSDoc 註解
    const jsDocs = ts.getJSDocCommentsAndTags(node);
    const doc = jsDocs
      .map((d) => (typeof d.comment === "string" ? d.comment : ""))
      .join(" ");
    console.log(`### ${node.name.text}`);
    console.log(doc || "（無說明）");
  }
  ts.forEachChild(node, visit);
}

visit(sourceFile);
/*
### add
計算兩數之和
*/
```

### 案例三：簡易 codemod — 重新命名 API 呼叫

把所有 `oldApi(...)` 的呼叫改成 `newApi(...)`：

```typescript
import * as ts from "typescript";

function renameCall(
  code: string,
  from: string,
  to: string,
): string {
  const sourceFile = ts.createSourceFile(
    "input.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
  );

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const { factory } = context;
    return (root) => {
      function visit(node: ts.Node): ts.Node {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === from
        ) {
          // 換掉被呼叫的識別字，保留原本的參數
          return factory.updateCallExpression(
            node,
            factory.createIdentifier(to),
            node.typeArguments,
            node.arguments,
          );
        }
        return ts.visitEachChild(node, visit, context);
      }
      return ts.visitNode(root, visit) as ts.SourceFile;
    };
  };

  const result = ts.transform(sourceFile, [transformer]);
  const printer = ts.createPrinter();
  const output = printer.printFile(result.transformed[0]);
  result.dispose();
  return output;
}

console.log(renameCall(`oldApi(1, 2); const x = oldApi(3);`, "oldApi", "newApi"));
// newApi(1, 2);
// const x = newApi(3);
```

---

## 14.10 相關工具生態

直接操作 Compiler API 很底層、也很囉嗦。多數情況下，用社群封裝好的工具會更有效率：

| 工具 | 定位 | 何時用 |
|------|------|--------|
| **[ts-morph](https://ts-morph.com/)** | Compiler API 的高階友善封裝 | 大部分 codemod、程式碼分析與產生的首選 |
| **typescript-eslint** | ESLint 的 TS parser 與型別感知規則 | 寫自訂 lint 規則 |
| **[TypeDoc](https://typedoc.org/)** | 從 TS 原始碼產生 API 文件 | 函式庫文件 |
| **ts-to-zod / typescript-json-schema** | 型別轉 schema | 從 TS 型別產生執行期驗證 |
| **[ts-ast-viewer.com](https://ts-ast-viewer.com/)** | 線上 AST 檢視 + factory 程式產生器 | 開發時必備輔助 |

### 什麼時候直接用 Compiler API vs ts-morph？

- **直接用 Compiler API**：需要最底層控制、極致效能、或做編譯外掛（transformer plugin）。
- **用 ts-morph**：一般的分析與改寫。它把「找節點、改節點、存檔」這些繁瑣操作包成直覺的物件導向 API，程式碼量能少一大截。

```typescript
// 同樣是「找出所有函式名稱」，用 ts-morph 只要幾行
import { Project } from "ts-morph";

const project = new Project();
project.addSourceFilesAtPaths("src/**/*.ts");

for (const sourceFile of project.getSourceFiles()) {
  for (const fn of sourceFile.getFunctions()) {
    console.log(fn.getName());
  }
}
```

---

## 練習題

### 練習 1：統計節點種類

寫一個程式，走訪一份原始碼的 AST，統計每種 `SyntaxKind` 出現的次數，並由多到少印出。

### 練習 2：找出所有 `any` 型別標註

利用 Compiler API 找出程式碼中所有明確標註為 `any` 的位置（提示：尋找 `SyntaxKind.AnyKeyword`），印出檔名與行號——這是一個實用的程式碼品質檢查工具。

### 練習 3：Transformer — 自動加上 `readonly`

寫一個 transformer，把所有 `interface` 的屬性都加上 `readonly` 修飾字。

### 練習 4：Code generation — 從 interface 產生工廠函式

給定一個 `interface`，用 `ts.factory` 產生一個 `createXxx()` 工廠函式的原始碼，回傳一個帶預設值的物件。

---

## 課程結語

恭喜你走到這裡！從 [第一章](./01-introduction.md) 的環境安裝，到 [第七章](./07-advanced-types.md) 的進階型別、[第十三章](./13-type-level-programming.md) 的型別層級程式設計，再到本章「用程式操作編譯器本身」——你已經看過 TypeScript 從「使用者」到「工具開發者」的完整光譜。

型別系統的深水區（第 13、14 章）不是每天都會用到，但理解它們能讓你：

- 讀懂並善用 `zod`、`tRPC`、`Prisma` 等函式庫背後的型別魔法。
- 在需要時，自己動手寫 codemod、lint 規則或程式碼產生器。
- 真正把 TypeScript 當成一門語言來理解，而不只是「加了型別的 JavaScript」。

> 回到 [課程首頁](./README.md) 複習其他章節，或挑一個練習題動手實作吧！
