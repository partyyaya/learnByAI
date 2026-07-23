// ┌─────────────────────────────────────────────────────────────┐
// │  compiler-api.ts —— TypeScript Compiler API 遊樂場            │
// ├─────────────────────────────────────────────────────────────┤
// │  執行： npm run capi   （或 npx tsx src/compiler-api.ts）     │
// │                                                               │
// │  搭配課程第 14 章「TypeScript Compiler API」閱讀。            │
// └─────────────────────────────────────────────────────────────┘

import * as ts from "typescript";

console.log(`TypeScript 版本：${ts.version}\n`);

// ── 範例 1：把原始碼字串解析成 AST，走訪並蒐集函式 / 變數名稱 ──
function listDeclarations(code: string): void {
  const sourceFile = ts.createSourceFile(
    "sample.ts",
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );

  const functions: string[] = [];
  const variables: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      functions.push(node.name.text);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      variables.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  console.log("① 走訪 AST");
  console.log("   函式：", functions);
  console.log("   變數：", variables, "\n");
}

// ── 範例 2：Transformer —— 移除所有 console.log(...) ──
function stripConsoleLog(code: string): string {
  const sourceFile = ts.createSourceFile(
    "input.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
  );

  const isConsoleLog = (node: ts.Node): boolean =>
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    ts.isPropertyAccessExpression(node.expression.expression) &&
    ts.isIdentifier(node.expression.expression.expression) &&
    node.expression.expression.expression.text === "console" &&
    node.expression.expression.name.text === "log";

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    return (root) => {
      const visit = (node: ts.Node): ts.Node | undefined => {
        node = ts.visitEachChild(node, visit, context);
        return isConsoleLog(node) ? undefined : node;
      };
      return ts.visitNode(root, visit) as ts.SourceFile;
    };
  };

  const result = ts.transform(sourceFile, [transformer]);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const output = printer.printFile(result.transformed[0]);
  result.dispose();
  return output;
}

// ── 範例 3：用 factory 從零產生一個 interface ──
function generateInterface(
  name: string,
  fields: { name: string; type: "string" | "number" | "boolean" }[],
): string {
  const f = ts.factory;
  const keyword = {
    string: ts.SyntaxKind.StringKeyword,
    number: ts.SyntaxKind.NumberKeyword,
    boolean: ts.SyntaxKind.BooleanKeyword,
  } as const;

  const decl = f.createInterfaceDeclaration(
    [f.createModifier(ts.SyntaxKind.ExportKeyword)],
    f.createIdentifier(name),
    undefined,
    undefined,
    fields.map((field) =>
      f.createPropertySignature(
        undefined,
        f.createIdentifier(field.name),
        undefined,
        f.createKeywordTypeNode(keyword[field.type]),
      ),
    ),
  );

  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const resultFile = ts.createSourceFile(
    "generated.ts",
    "",
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  return printer.printNode(ts.EmitHint.Unspecified, decl, resultFile);
}

// ── 執行示範 ──
listDeclarations(`const a = 1; function foo() {} const b = 2;`);

console.log("② 移除 console.log");
console.log(
  stripConsoleLog(`function greet(name) {
  console.log("debug", name);
  return "Hi " + name;
}`),
);

console.log("③ 產生 interface");
console.log(
  generateInterface("User", [
    { name: "id", type: "number" },
    { name: "name", type: "string" },
    { name: "active", type: "boolean" },
  ]),
);
