import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import ts from "typescript";

const sourceRoot = resolvePath(process.cwd(), "src");

export async function resolve(specifier, context, nextResolve) {
  const candidates = [];
  if (specifier.startsWith("@/")) {
    candidates.push(resolvePath(sourceRoot, specifier.slice(2)));
  } else if (specifier.startsWith(".") && context.parentURL) {
    candidates.push(resolvePath(fileURLToPath(new URL(".", context.parentURL)), specifier));
  }

  for (const candidate of candidates) {
    for (const path of [candidate, `${candidate}.ts`, `${candidate}.tsx`, resolvePath(candidate, "index.ts")]) {
      if (existsSync(path)) return nextResolve(pathToFileURL(path).href, context);
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".ts") || url.endsWith(".tsx")) {
    const source = await readFile(fileURLToPath(url), "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
      fileName: fileURLToPath(url),
    });
    return { format: "module", source: output.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
