// @ts-ignore: no types available.
import * as pirates from "pirates";
import {Transform, transform} from "./index";

export function addHook(extension: string, transforms: Array<Transform>): void {
  pirates.addHook(
    (code: string, filePath: string): string => transform(code, {filePath, transforms}),
    {exts: [extension]},
  );
}

export function registerJS(): void {
  addHook(".js", ["imports", "flow", "jsx"]);
}

export function registerJSX(): void {
  addHook(".jsx", ["imports", "flow", "jsx"]);
}

export function registerTS(): void {
  addHook(".ts", ["imports", "typescript"]);
}

export function registerTSX(): void {
  addHook(".tsx", ["imports", "typescript", "jsx"]);
}

export function registerAll(): void {
  registerJS();
  registerJSX();
  registerTS();
  registerTSX();
}
