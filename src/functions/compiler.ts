import { parse, type Pattern } from 'acorn';

/**
 * Handler modules keep their local bindings in both execution environments.
 * Parse exports instead of rewriting text inside comments, strings or functions.
 * Keep this module and its contract corpus identical in the app and API repos.
 */
export function compileToCjs(code: string): string {
  const program = parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  const rejectDynamicImports = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if ((value as { type?: string }).type === 'ImportExpression')
      throw new Error(
        'Handler imports are not supported. Keep helpers in this function file.',
      );
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(rejectDynamicImports);
      else if (child && typeof child === 'object') rejectDynamicImports(child);
    }
  };
  rejectDynamicImports(program);
  const edits: { start: number; end: number; text: string }[] = [];
  const bindings: [string, string][] = [];
  const names = (pattern: Pattern): string[] => {
    switch (pattern.type) {
      case 'Identifier':
        return [pattern.name];
      case 'RestElement':
        return names(pattern.argument);
      case 'AssignmentPattern':
        return names(pattern.left);
      case 'ArrayPattern':
        return pattern.elements.flatMap((item) => (item ? names(item) : []));
      case 'ObjectPattern':
        return pattern.properties.flatMap((property) =>
          names(
            property.type === 'RestElement'
              ? property.argument
              : (property.value as Pattern),
          ),
        );
      default:
        return [];
    }
  };
  for (const node of program.body) {
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      (node.type === 'ExportNamedDeclaration' && node.source)
    )
      throw new Error(
        'Handler imports are not supported. Keep helpers in this function file.',
      );
    if (node.type === 'ExportDefaultDeclaration') {
      const declaration = node.declaration;
      if (
        (declaration.type === 'FunctionDeclaration' ||
          declaration.type === 'ClassDeclaration') &&
        declaration.id
      ) {
        edits.push({ start: node.start, end: declaration.start, text: '' });
        bindings.push(['default', declaration.id.name]);
      } else
        edits.push({
          start: node.start,
          end: declaration.start,
          text: 'module.exports.default = ',
        });
    } else if (node.type === 'ExportNamedDeclaration') {
      const declaration = node.declaration;
      if (declaration) {
        edits.push({ start: node.start, end: declaration.start, text: '' });
        const declared =
          declaration.type === 'VariableDeclaration'
            ? declaration.declarations.flatMap((item) => names(item.id))
            : [declaration.id.name];
        for (const name of declared) bindings.push([name, name]);
      } else {
        edits.push({ start: node.start, end: node.end, text: '' });
        for (const specifier of node.specifiers) {
          if (specifier.local.type !== 'Identifier')
            throw new Error('Invalid local export.');
          bindings.push([
            specifier.exported.type === 'Identifier'
              ? specifier.exported.name
              : String(specifier.exported.value),
            specifier.local.name,
          ]);
        }
      }
    }
  }
  let result = code;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return (
    '"use strict";\n' +
    result +
    '\n' +
    bindings
      .map(
        ([exported, local]) =>
          `Object.defineProperty(module.exports, ${JSON.stringify(exported)}, { enumerable: true, get: () => ${local} });`,
      )
      .join('\n')
  );
}
