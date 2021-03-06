import {flowParseAssignableListItemTypes} from "../plugins/flow";
import {
  tsParseAccessModifier,
  tsParseAssignableListItemTypes,
  tsParseModifier,
} from "../plugins/typescript";
import {ContextualKeyword, eat, IdentifierRole, match, next, runInTypeContext} from "../tokenizer";
import {TokenType, TokenType as tt} from "../tokenizer/types";
import {hasPlugin, state} from "./base";
import {parseIdentifier, parseMaybeAssign, parseObj} from "./expression";
import {expect, unexpected} from "./util";

export function parseSpread(): void {
  next();
  parseMaybeAssign(false);
}

export function parseRest(isBlockScope: boolean): void {
  next();
  parseBindingAtom(isBlockScope);
}

export function parseBindingIdentifier(): void {
  parseIdentifier();
}

// Parses lvalue (assignable) atom.
export function parseBindingAtom(isBlockScope: boolean): void {
  switch (state.type) {
    case tt._this:
      // In TypeScript, "this" may be the name of a parameter, so allow it.
      runInTypeContext(0, () => {
        next();
      });
      return;

    case tt._yield:
    case tt.name: {
      state.type = tt.name;
      parseBindingIdentifier();
      state.tokens[state.tokens.length - 1].identifierRole = isBlockScope
        ? IdentifierRole.BlockScopedDeclaration
        : IdentifierRole.FunctionScopedDeclaration;
      return;
    }

    case tt.bracketL: {
      next();
      parseBindingList(tt.bracketR, isBlockScope, true /* allowEmpty */);
      return;
    }

    case tt.braceL:
      parseObj(true, isBlockScope);
      return;

    default:
      throw unexpected();
  }
}

export function parseBindingList(
  close: TokenType,
  isBlockScope: boolean,
  allowEmpty?: boolean,
  allowModifiers: boolean | null = null,
): void {
  let first = true;

  let hasRemovedComma = false;
  const firstItemTokenIndex = state.tokens.length;

  while (!eat(close)) {
    if (first) {
      first = false;
    } else {
      expect(tt.comma);
      // After a "this" type in TypeScript, we need to set the following comma (if any) to also be
      // a type token so that it will be removed.
      if (!hasRemovedComma && state.tokens[firstItemTokenIndex].isType) {
        state.tokens[state.tokens.length - 1].isType = true;
        hasRemovedComma = true;
      }
    }
    if (allowEmpty && match(tt.comma)) {
      // Empty item; nothing further to parse for this item.
    } else if (eat(close)) {
      break;
    } else if (match(tt.ellipsis)) {
      parseRest(isBlockScope);
      parseAssignableListItemTypes();
      expect(close);
      break;
    } else {
      parseAssignableListItem(allowModifiers, isBlockScope);
    }
  }
}

function parseAssignableListItem(allowModifiers: boolean | null, isBlockScope: boolean): void {
  if (allowModifiers) {
    tsParseAccessModifier();
    tsParseModifier([ContextualKeyword._readonly]);
  }

  parseMaybeDefault(isBlockScope);
  parseAssignableListItemTypes();
  parseMaybeDefault(isBlockScope, true /* leftAlreadyParsed */);
}

function parseAssignableListItemTypes(): void {
  if (hasPlugin("flow")) {
    flowParseAssignableListItemTypes();
  } else if (hasPlugin("typescript")) {
    tsParseAssignableListItemTypes();
  }
}

// Parses assignment pattern around given atom if possible.
export function parseMaybeDefault(isBlockScope: boolean, leftAlreadyParsed: boolean = false): void {
  if (!leftAlreadyParsed) {
    parseBindingAtom(isBlockScope);
  }
  if (!eat(tt.eq)) {
    return;
  }
  parseMaybeAssign();
}
