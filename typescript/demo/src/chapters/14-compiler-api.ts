// ============================================================
// 第 14 章：TypeScript Compiler API — 範例整理（可編譯 + 可執行）
// 來源：typescript/14-compiler-api.md
// 說明：
//   - 「解析字串 + 走訪 AST + transformer + printer + factory」等
//     不碰檔案系統、不 process.exit 的安全範例，會實際呼叫並 console.log。
//   - 「createProgram 去讀不存在的 sample.ts / emit / getPreEmitDiagnostics /
//     讀 tsconfig / ts.sys.*」等有副作用的範例，一律包進「定義了但不呼叫」
//     的具名函式（demoXxx / findUnusedExports），避免用 tsx 執行整檔時崩潰。
//   - 14.10 的 ts-morph 範例因未安裝套件，以區塊註解保留為參考。
// ============================================================

import * as ts from "typescript";
import * as path from "path";

// ===== 14.3 環境設定：印出 TypeScript 版本（安全，直接執行） =====
console.log("14.3 TypeScript 版本：", ts.version); // 例如 "5.9.3"

// ===== 14.4 建立 SourceFile 與走訪 AST（安全，直接執行） =====
function demoWalkAst(): void {
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

  console.log("14.4 走訪 AST：");
  printNode(sourceFile);
}
demoWalkAst();

// ===== 14.4 用型別守衛函式判斷節點種類（安全，直接執行） =====
function demoTypeGuards(): void {
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
  console.log("14.4 函式：", functionNames); // ["foo"]
  console.log("14.4 變數：", variableNames); // ["a", "b"]
}
demoTypeGuards();

// ===== 14.5 使用 Program 與 TypeChecker 取得型別資訊（有副作用：讀 sample.ts，定義但不呼叫） =====
function demoTypeChecker(): void {
  // analyze.ts
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
}

/*
// 若 sample.ts 內容為（供 demoTypeChecker / demoMiniTsc 等參考）：
// sample.ts
export function add(a: number, b: number): number {
  return a + b;
}
export function greet(name: string): string {
  return `Hi, ${name}`;
}

// 執行 `npx tsx analyze.ts` 會印出：
// add(a: number, b: number): number
// greet(name: string): string
*/

// ===== 14.6 型別檢查與診斷：做一個 mini tsc（有副作用：emit + 讀 sample.ts，定義但不呼叫） =====
function demoMiniTsc(): void {
  // mini-tsc.ts
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
}

// ===== 14.6 讀取專案的 tsconfig.json（有副作用：ts.sys 讀檔，定義但不呼叫） =====
function demoLoadTsConfig(): void {
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
  void program;
}

// ===== 14.6 更漂亮的錯誤輸出（有副作用：ts.sys + 讀 sample.ts，定義但不呼叫） =====
function demoFormatDiagnostics(): void {
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
}

// ===== 14.7 轉換 AST（Transformer）：移除所有 console.log(...)（安全，直接執行） =====
function demoRemoveConsole(): void {
  // remove-console.ts
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
  console.log("14.7 移除 console.log 後：\n" + output);
  result.dispose(); // 記得釋放資源

  /*
  function greet(name: string) {
      const msg = "Hello, " + name;
      return msg;
  }
  */
}
demoRemoveConsole();

// ===== 14.7 用 factory 修改節點：把所有數字字面值 +1（安全，直接執行） =====
function demoIncrementNumbers(): void {
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

  // 實際套用示範（原文只定義 transformer，這裡加上套用以便看到輸出）
  const sourceFile = ts.createSourceFile(
    "nums.ts",
    `const arr = [1, 2, 3];`,
    ts.ScriptTarget.Latest,
    true,
  );
  const result = ts.transform(sourceFile, [incrementNumbers]);
  const printer = ts.createPrinter();
  console.log(
    "14.7 數字 +1 後：",
    printer.printFile(result.transformed[0]).trim(),
  );
  result.dispose();
}
demoIncrementNumbers();

// ===== 14.8 從零產生程式碼（Code Generation）：產生 interface（安全，直接執行） =====
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

function demoCodegen(): void {
  const output = generateInterface("User", [
    { name: "id", type: "number" },
    { name: "name", type: "string" },
    { name: "email", type: "string", optional: true },
  ]);

  console.log("14.8 產生的 interface：\n" + output);
  /*
  export interface User {
      id: number;
      name: string;
      email?: string;
  }
  */
}
demoCodegen();

// ===== 14.9 實戰案例一：找出所有未被使用的 export（有副作用：createProgram，定義但不呼叫） =====
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

// ===== 14.9 實戰案例二：抽取 JSDoc 註解產生 API 文件（安全，直接執行） =====
function demoJSDoc(): void {
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
      console.log(`14.9 ### ${node.name.text}`);
      console.log(doc || "（無說明）");
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  /*
  ### add
  計算兩數之和
  */
}
demoJSDoc();

// ===== 14.9 實戰案例三：簡易 codemod — 重新命名 API 呼叫（安全，直接執行） =====
function renameCall(code: string, from: string, to: string): string {
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

function demoRenameCall(): void {
  console.log(
    "14.9 rename 結果：\n" +
      renameCall(`oldApi(1, 2); const x = oldApi(3);`, "oldApi", "newApi"),
  );
  // newApi(1, 2);
  // const x = newApi(3);
}
demoRenameCall();

// ===== 14.10 相關工具生態：ts-morph（未安裝，僅保留為註解參考，不 import/不執行） =====
// 注意：這段刻意用「行註解」而非 /* ... */ 區塊註解，因為 glob "src/**/*.ts"
//       內含 */ 序列會提前結束區塊註解；語意上同樣是「整段註解掉、不執行」。
//
// // 同樣是「找出所有函式名稱」，用 ts-morph 只要幾行
// import { Project } from "ts-morph";
//
// const project = new Project();
// project.addSourceFilesAtPaths("src/**/*.ts");
//
// for (const sourceFile of project.getSourceFiles()) {
//   for (const fn of sourceFile.getFunctions()) {
//     console.log(fn.getName());
//   }
// }

console.log("第 14 章 Compiler API 範例載入完成 ✅");

export {};
