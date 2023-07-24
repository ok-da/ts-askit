import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';
import { throwError } from '../common';
import { getIdentifierValue } from '../expression';
import { JsTypeGenerator, convertToDynamicType } from '../type';
import { generateUniqueFunctionName } from '../function-name';
import { Info } from '../info';
import { ExampleType } from '../example';
import { makeExpressionFromString } from '../ast';
import { convertTemplate, extractVariables } from '../template';

const MODULE_NAME = 'ts-askit';

let functions: ts.FunctionDeclaration[] = [];
let imports: ts.ImportDeclaration[] = [];

function update(node: ts.SourceFile): ts.SourceFile {
  if (
    !fs.existsSync(node.fileName) &&
    path.basename(node.fileName) !== '<repl>.ts'
  ) {
    // Skip the code transpiled by askgen
    // console.log('Skip:', node.fileName);
    return node;
  }

  // Add funcNode to node.statements
  const statements = [
    ...imports,
    // createRequire('__askJson__', 'askJson', [MODULE_NAME]),
    ...[
      'type',
      'array',
      'string',
      'number',
      'boolean',
      'object',
      'union',
      'literal',
    ].map((name) =>
      createRequire(`__${name}__`, name, [MODULE_NAME + '/types'])
    ),
    ...functions,
    ...node.statements,
  ];
  imports = [];
  functions = [];
  return ts.factory.updateSourceFile(node, statements);
}

function createRequire(jsName: string, name: string, modNames: string[]) {
  const varDeclaration = ts.factory.createVariableDeclaration(
    jsName,
    undefined,
    undefined,
    ts.factory.createPropertyAccessExpression(
      ts.factory.createCallExpression(
        ts.factory.createIdentifier('require'),
        undefined,
        modNames.map((name) => ts.factory.createStringLiteral(name))
      ),
      name
    )
  );
  // Create a variable statement (var/let/const) for the 'askJson' function
  const varStatement = ts.factory.createVariableStatement(
    [ts.factory.createModifier(ts.SyntaxKind.ConstKeyword)],
    ts.factory.createVariableDeclarationList(
      [varDeclaration],
      ts.NodeFlags.Const
    )
  );
  return varStatement;
}

function saveInfo(fileName: string, info: Info[]) {
  if (info.length === 0) {
    return;
  }
  const dirName = path.dirname(fileName);
  const baseName = path.basename(fileName);
  const jsonlDirName = path.join(dirName, 'askit');
  if (!fs.existsSync(jsonlDirName)) {
    fs.mkdirSync(jsonlDirName);
  }
  const jsonlPath = path.join(jsonlDirName, baseName + '.jsonl');
  const jsonl = info.map((item) => JSON.stringify(item)).join('\n');
  fs.writeFileSync(jsonlPath, jsonl);
}

export function transformer(
  program: ts.Program
): ts.TransformerFactory<ts.SourceFile> {
  return (context) => {
    return (file) => {
      try {
        const info: Info[] = [];
        const x = ts.visitEachChild(
          file,
          (node) => visit(info, node, context),
          context
        );
        saveInfo(file.fileName, info);
        return update(x);
      } catch (error: any) {
        //console.log(error.message);
        throw error;
        return file;
      }
    };
  };

  function visit(
    info: Info[],
    node: ts.Node,
    context: ts.TransformationContext
  ): ts.Node {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (['llm', 'ask'].includes(node.expression.escapedText.toString())) {
        return rewriteAskCall(info, node, program.getTypeChecker());
      } else if (['define'].includes(node.expression.escapedText.toString())) {
        return rewriteDefineCall(info, node, program.getTypeChecker());
      }
    }
    return ts.visitEachChild(
      node,
      (node) => visit(info, node, context),
      context
    );
  }
}

function rewriteDefineCall(
  info: Info[],
  node: ts.CallExpression,
  checker: ts.TypeChecker
): ts.Node {
  if (node.arguments.length > 0 && !ts.isStringLiteralLike(node.arguments[0])) {
    return node;
  }
  if (node.typeArguments?.length !== 1) {
    throwError(node, `expects exactly one type parameter`);
  }

  const returnType = node.typeArguments[0];
  const typeExpression = createTypeExpression(returnType, checker);
  const newNode = ts.factory.updateCallExpression(
    node,
    node.expression,
    node.typeArguments,
    [typeExpression, ...node.arguments]
  );
  return newNode;
}

function createTypeExpression(
  returnType: ts.TypeNode,
  checker: ts.TypeChecker
) {
  const generator = new JsTypeGenerator();
  const typeString = generator.makeTypeDirection(returnType, checker);
  const typeExpression = makeExpressionFromString(typeString);
  return typeExpression;
}

function printNode(node: ts.Node): string {
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  return printer.printNode(
    ts.EmitHint.Unspecified,
    node,
    ts.createSourceFile('', '', ts.ScriptTarget.Latest)
  );
}

function rewriteAskCall(
  info: Info[],
  node: ts.CallExpression,
  checker: ts.TypeChecker
): ts.Node {
  if (node.arguments.length > 0 && !ts.isStringLiteralLike(node.arguments[0])) {
    return node;
  }
  if (node.typeArguments?.length !== 1) {
    throwError(node, `expects exactly one type parameter`);
  }
  const template = node.arguments[0] as ts.StringLiteral;
  const variables = extractVariables(template.text);
  const variableMapObject = makeVariableMapObject(variables);
  const returnType = node.typeArguments[0];
  const generator = new JsTypeGenerator();
  //  const typeString = generator.makeTypeDirection(returnType, checker);
  //  const typeExpression = makeExpressionFromString(typeString);

  const typeExpression = convertToDynamicType(returnType, checker);

  const examplesNode =
    node.arguments.length >= 2
      ? node.arguments[1]
      : ts.factory.createArrayLiteralExpression([], false);

  const symbols = checker.getSymbolsInScope(node, ts.SymbolFlags.Variable);

  const varSymbols = variables.map((variable) => {
    const symbol = symbols.find((symbol) => symbol.name == variable);
    if (!symbol) {
      throwError(node, `Unknown variable: ${variable}`);
    }
    return symbol;
  });
  const types = (varSymbols as ts.Symbol[]).map((symbol) =>
    checker.getTypeOfSymbolAtLocation(
      symbol,
      symbol.valueDeclaration as ts.Node
    )
  );
  const paramTypeStrings = types.map((type) => checker.typeToString(type));
  const returnTypeString = checker.typeToString(
    checker.getTypeAtLocation(returnType)
  );
  const name = generateUniqueFunctionName(
    [template.text, ...paramTypeStrings, returnTypeString].join('_')
  );
  const args = varSymbols.map((sym) => ts.factory.createIdentifier(sym.name));
  const decl = makeSignature(name, returnType, varSymbols, checker);
  const signature = printNode(decl);
  const params: [string, string][] = varSymbols.map((sym, i) => [
    paramTypeStrings[i],
    sym.name,
  ]);
  const examples = (
    node.arguments.length >= 2 && ts.isIdentifier(node.arguments[1])
      ? getIdentifierValue(node.arguments[1], checker)
      : []
  ) as ExampleType[];
  info.push({
    signature,
    desc: convertTemplate(template.text),
    params,
    name,
    examples,
  });

  const sourceFileName = node.getSourceFile().fileName;
  const { moduleName, modulePath } = makeModuleName(sourceFileName, name);
  if (fs.existsSync(modulePath)) {
    console.log('Found:', moduleName);

    const importStatement = ts.factory.createImportDeclaration(
      undefined,
      ts.factory.createImportClause(
        false,
        undefined,
        ts.factory.createNamedImports([
          ts.factory.createImportSpecifier(
            false,
            undefined,
            ts.factory.createIdentifier(name)
          ),
        ])
      ),
      ts.factory.createStringLiteral('./askit/' + moduleName)
    );
    imports.push(importStatement);
    return makeCall(moduleName, name, args);
  } else {
    const newNode = ts.factory.updateCallExpression(
      node,
      node.expression,
      node.typeArguments,
      [typeExpression, template, examplesNode, variableMapObject]
    );
    return newNode;
  }
}

function makeVariableMapObject(variables: string[]) {
  return ts.factory.createObjectLiteralExpression(
    variables.map((variable) =>
      ts.factory.createPropertyAssignment(
        variable,
        ts.factory.createIdentifier(variable)
      )
    )
  );
}

export function makeModuleName(sourceFileName: string, name: string) {
  const baseName = path.basename(sourceFileName, '.ts');
  const sourceDir = path.dirname(sourceFileName);
  const modulePath = path.join(sourceDir, 'askit', name + '.ts');
  const moduleName = name;
  return { modulePath, moduleName };
}

function makeCall(
  moduleName: string,
  name: string,
  args: ts.Expression[]
): ts.CallExpression {
  return ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(
      ts.factory.createIdentifier(`${moduleName}_1`),
      ts.factory.createIdentifier(name)
    ),
    undefined,
    args
  );
}

function makeSignature(
  name: string,
  type: ts.TypeNode,
  symbols: ts.Symbol[],
  checker: ts.TypeChecker
) {
  const params = symbols.map((sym) => {
    const t = checker.typeToString(
      checker.getTypeOfSymbolAtLocation(sym, sym.valueDeclaration as ts.Node)
    );
    return ts.factory.createParameterDeclaration(
      undefined,
      undefined,
      sym.name,
      undefined,
      ts.factory.createTypeReferenceNode(t, undefined)
    );
  });

  const exportModifier = ts.factory.createModifier(ts.SyntaxKind.ExportKeyword);

  const signature = ts.factory.createFunctionDeclaration(
    [exportModifier],
    undefined,
    name,
    undefined,
    params,
    type,
    undefined
  );

  return signature;
}

export default transformer;
