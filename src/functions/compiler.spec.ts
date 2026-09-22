import * as vm from 'node:vm';
import { compileToCjs } from './compiler';
import * as cases from './compiler-cases.json';

// Same handler corpus as app/src/services/function-compiler-cases.json.
it.each(cases)('$name runs in the API VM', async ({ code, body, expected }) => {
  const sandbox = {
    module: { exports: {} as { default?: (req: unknown) => unknown } },
  };
  vm.runInNewContext(compileToCjs(code), sandbox, { timeout: 200 });
  const result = await sandbox.module.exports.default!({
    json: async () => body,
  });
  expect(JSON.parse(JSON.stringify(result))).toEqual(expected);
});

it.each([
  "import helper from './helper.js'; export default helper;",
  "export default async () => import('https://example.com/helper.js');",
])('refuses module imports in a handler', (code) => {
  expect(() => compileToCjs(code)).toThrow('Handler imports are not supported');
});
