import {TokenType as tt} from "../../sucrase-babylon/tokenizer/types";
import {SucraseContext, Transform} from "../index";
import NameManager from "../NameManager";
import TokenProcessor from "../TokenProcessor";
import getClassInfo, {ClassInfo} from "../util/getClassInfo";
import FlowTransformer from "./FlowTransformer";
import ImportTransformer from "./ImportTransformer";
import JSXTransformer from "./JSXTransformer";
import NumericSeparatorTransformer from "./NumericSeparatorTransformer";
import OptionalCatchBindingTransformer from "./OptionalCatchBindingTransformer";
import ReactDisplayNameTransformer from "./ReactDisplayNameTransformer";
import Transformer from "./Transformer";
import TypeScriptTransformer from "./TypeScriptTransformer";

export default class RootTransformer {
  private transformers: Array<Transformer> = [];
  private nameManager: NameManager;
  private tokens: TokenProcessor;
  private generatedVariables: Array<string> = [];

  constructor(
    sucraseContext: SucraseContext,
    transforms: Array<Transform>,
    filePath: string | null,
  ) {
    this.nameManager = sucraseContext.nameManager;
    const {tokenProcessor, importProcessor} = sucraseContext;
    this.tokens = tokenProcessor;

    this.transformers.push(new NumericSeparatorTransformer(tokenProcessor));
    this.transformers.push(new OptionalCatchBindingTransformer(tokenProcessor, this.nameManager));
    if (transforms.includes("jsx")) {
      this.transformers.push(
        new JSXTransformer(this, tokenProcessor, importProcessor, this.nameManager, filePath),
      );
      this.transformers.push(
        new ReactDisplayNameTransformer(this, tokenProcessor, importProcessor),
      );
    }

    if (transforms.includes("imports")) {
      const shouldAddModuleExports = transforms.includes("add-module-exports");
      this.transformers.push(
        new ImportTransformer(this, tokenProcessor, importProcessor, shouldAddModuleExports),
      );
    }

    if (transforms.includes("flow")) {
      this.transformers.push(new FlowTransformer(this, tokenProcessor));
    }
    if (transforms.includes("typescript")) {
      if (!transforms.includes("imports")) {
        throw new Error(
          "The TypeScript transform without the import transform is not yet supported.",
        );
      }
      this.transformers.push(new TypeScriptTransformer(this, tokenProcessor));
    }
  }

  transform(): string {
    this.tokens.reset();
    this.processBalancedCode();
    const shouldAddUseStrict = this.transformers.some((t) => t instanceof ImportTransformer);
    // "use strict" always needs to be first, so override the normal transformer order.
    let prefix = shouldAddUseStrict ? '"use strict";' : "";
    for (const transformer of this.transformers) {
      prefix += transformer.getPrefixCode();
    }
    prefix += this.generatedVariables.map((v) => ` var ${v};`).join("");
    let suffix = "";
    for (const transformer of this.transformers) {
      suffix += transformer.getSuffixCode();
    }
    let code = this.tokens.finish();
    if (code.startsWith("#!")) {
      let newlineIndex = code.indexOf("\n");
      if (newlineIndex === -1) {
        newlineIndex = code.length;
        code += "\n";
      }
      return code.slice(0, newlineIndex + 1) + prefix + code.slice(newlineIndex + 1) + suffix;
    } else {
      return prefix + this.tokens.finish() + suffix;
    }
  }

  processBalancedCode(): void {
    let braceDepth = 0;
    let parenDepth = 0;
    while (!this.tokens.isAtEnd()) {
      if (this.tokens.matches1(tt.braceL) || this.tokens.matches1(tt.dollarBraceL)) {
        braceDepth++;
      } else if (this.tokens.matches1(tt.braceR)) {
        if (braceDepth === 0) {
          return;
        }
        braceDepth--;
      }
      if (this.tokens.matches1(tt.parenL)) {
        parenDepth++;
      } else if (this.tokens.matches1(tt.parenR)) {
        if (parenDepth === 0) {
          return;
        }
        parenDepth--;
      }
      this.processToken();
    }
  }

  processToken(): void {
    if (this.tokens.matches1(tt._class)) {
      this.processClass();
      return;
    }
    for (const transformer of this.transformers) {
      const wasProcessed = transformer.process();
      if (wasProcessed) {
        return;
      }
    }
    this.tokens.copyToken();
  }

  /**
   * Skip past a class with a name and return that name.
   */
  processNamedClass(): string {
    if (!this.tokens.matches2(tt._class, tt.name)) {
      throw new Error("Expected identifier for exported class name.");
    }
    const name = this.tokens.identifierNameAtIndex(this.tokens.currentIndex() + 1);
    this.processClass();
    return name;
  }

  processClass(): void {
    const classInfo = getClassInfo(this, this.tokens);

    const needsCommaExpression =
      classInfo.headerInfo.isExpression && classInfo.staticInitializerSuffixes.length > 0;

    let className = classInfo.headerInfo.className;
    if (needsCommaExpression) {
      className = this.nameManager.claimFreeName("_class");
      this.generatedVariables.push(className);
      this.tokens.appendCode(` (${className} =`);
    }

    const classToken = this.tokens.currentToken();
    const contextId = classToken.contextId;
    if (contextId == null) {
      throw new Error("Expected class to have a context ID.");
    }
    this.tokens.copyExpectedToken(tt._class);
    while (!this.tokens.matchesContextIdAndLabel(tt.braceL, contextId)) {
      this.processToken();
    }

    this.processClassBody(classInfo);

    const staticInitializerStatements = classInfo.staticInitializerSuffixes.map(
      (suffix) => `${className}${suffix}`,
    );
    if (needsCommaExpression) {
      this.tokens.appendCode(`, ${staticInitializerStatements.join(", ")}, ${className})`);
    } else if (classInfo.staticInitializerSuffixes.length > 0) {
      this.tokens.appendCode(` ${staticInitializerStatements.join("; ")};`);
    }
  }

  /**
   * We want to just handle class fields in all contexts, since TypeScript supports them. Later,
   * when some JS implementations support class fields, this should be made optional.
   */
  processClassBody(classInfo: ClassInfo): void {
    const {headerInfo, constructorInsertPos, initializerStatements, fieldRanges} = classInfo;
    let fieldIndex = 0;
    const classContextId = this.tokens.currentToken().contextId;
    if (classContextId == null) {
      throw new Error("Expected non-null context ID on class.");
    }
    this.tokens.copyExpectedToken(tt.braceL);

    if (constructorInsertPos === null && initializerStatements.length > 0) {
      const initializersCode = initializerStatements.join(";");
      if (headerInfo.hasSuperclass) {
        const argsName = this.nameManager.claimFreeName("args");
        this.tokens.appendCode(
          `constructor(...${argsName}) { super(...${argsName}); ${initializersCode}; }`,
        );
      } else {
        this.tokens.appendCode(`constructor() { ${initializersCode}; }`);
      }
    }

    while (!this.tokens.matchesContextIdAndLabel(tt.braceR, classContextId)) {
      if (
        fieldIndex < fieldRanges.length &&
        this.tokens.currentIndex() === fieldRanges[fieldIndex].start
      ) {
        this.tokens.removeInitialToken();
        while (this.tokens.currentIndex() < fieldRanges[fieldIndex].end) {
          this.tokens.removeToken();
        }
        fieldIndex++;
      } else if (this.tokens.currentIndex() === constructorInsertPos) {
        this.tokens.copyToken();
        if (initializerStatements.length > 0) {
          this.tokens.appendCode(`;${initializerStatements.join(";")};`);
        }
        this.processToken();
      } else {
        this.processToken();
      }
    }
    this.tokens.copyExpectedToken(tt.braceR);
  }

  processPossibleTypeRange(): boolean {
    if (this.tokens.currentToken().isType) {
      this.tokens.removeInitialToken();
      while (this.tokens.currentToken().isType) {
        this.tokens.removeToken();
      }
      return true;
    }
    return false;
  }
}
