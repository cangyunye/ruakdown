// turndown-plugin-gfm ships no type declarations; the plugin functions all
// have the turndown `Plugin` shape (service => void).
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  export function gfm(service: TurndownService): void;
  export function highlightedCodeBlock(service: TurndownService): void;
  export function strikethrough(service: TurndownService): void;
  export function tables(service: TurndownService): void;
  export function taskListItems(service: TurndownService): void;
}
